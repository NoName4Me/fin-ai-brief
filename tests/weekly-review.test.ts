import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { db, pool } from '../src/server/db.ts';
import { articles, events, briefs } from '../src/server/schema.ts';
import { migrate } from '../scripts/migrate.ts';
import { saveSettings } from '../src/server/settings.ts';
import { defaultSettings, briefContentSchema } from '../src/server/types.ts';
import { weeklyMaterials, weeklyProgress } from '../src/server/weekly-review.ts';
import { generateBrief, previewBrief } from '../src/server/briefs.ts';
import { renderEmail } from '../src/server/mail-template.ts';
import { PeriodBrief } from '../src/components/period-brief.tsx';

if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('必须使用独立_test数据库');
const originalFetch = globalThis.fetch;
const range = { start: new Date('2026-10-19T00:00:00Z'), end: new Date('2026-10-26T00:00:00Z') };
let eventId: string;
let developmentIds: string[];
let articleIds: string[];
let captured = '';
before(async () => {
  await migrate();
});
after(async () => {
  globalThis.fetch = originalFetch;
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE processing_steps,model_calls,brief_requests,deliveries,briefs,articles,events CASCADE',
  );
  await saveSettings({ ...defaultSettings, autoPublish: false, weeklyTime: '08:00', weeklyDay: 1 });
  process.env.MODEL_CALLS_ENABLED = 'true';
  process.env.MAIL_ENABLED = 'false';
  process.env.LLM_API_KEY = 'test-only';
  process.env.LLM_BASE_URL = 'http://model.invalid/v1';
  process.env.LLM_MODEL = 'test';
  eventId = randomUUID();
  developmentIds = [];
  articleIds = [];
  captured = '';
  // The event was updated after the issue cutoff and now has a different score/category/state.
  await db.insert(events).values({
    id: eventId,
    industryId: 'finance',
    title: '未来标题',
    summary: '未来状态',
    section: '未来分类',
    score: 0,
    occurredAt: new Date('2026-10-28T00:00:00Z'),
  });
  const rows = [
    ['2026-10-17T02:00:00Z', '前期提出试点计划', 'planned'],
    ['2026-10-20T02:00:00Z', '宣布启动试点', 'announced'],
    ['2026-10-22T02:00:00Z', '公布试点名单', 'announced'],
    ['2026-10-23T02:00:00Z', '宣布启动试点', 'announced'], // duplicate report: no development
    ['2026-10-28T02:00:00Z', '未来材料不得出现', 'confirmed'],
  ];
  for (const [i, [date, text, status]] of rows.entries()) {
    const articleId = randomUUID();
    articleIds.push(articleId);
    await db.insert(articles).values({
      id: articleId,
      eventId,
      industryId: 'finance',
      sourceName: '测试来源（RSS）',
      url: `https://example.invalid/${articleId}`,
      title: text,
      excerpt: `材料：${text}。`,
      publishedAt: new Date(date),
      state: 'processed',
    });
    if (i !== 3) {
      const id = randomUUID();
      developmentIds.push(id);
      await pool.query(
        'INSERT INTO event_developments(id,event_id,article_id,fact_hash,facts,happened_at,editorial) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          eventId,
          articleId,
          `fact-${i}`,
          JSON.stringify([{ statement: text, evidence: text, status }]),
          new Date(date),
          JSON.stringify({ title: text, summary: text, section: '行业监管', score: 80 }),
        ],
      );
    }
  }
  globalThis.fetch = async (_url, init) => {
    captured = String(init?.body);
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                title: '试点从启动到名单披露',
                overview: { finance: '本周试点启动并公布名单。' },
                items: [
                  {
                    eventId,
                    title: '试点启动后公布名单',
                    summary: '本周宣布启动试点，并公布试点名单。',
                    progress: [
                      { text: '公布试点名单。', developmentIds: [developmentIds[2]] },
                      { text: '宣布启动试点。', developmentIds: [developmentIds[1]] },
                    ],
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    );
  };
});

test('周报按周内事实选题，采用当期评分与分类，不带入未来摘要；重复报道保留来源', async () => {
  const materials = await weeklyMaterials(range, 60, 16);
  assert.equal(materials.selected.length, 1);
  assert.equal(materials.selected[0].section, '行业监管');
  assert.equal(materials.inputEvents[0].developments.length, 2);
  assert.equal(materials.inputEvents[0].background.length, 1);
  const input = JSON.stringify(materials.inputEvents);
  assert.ok(!input.includes('未来'));
  assert.equal(materials.refs.length, 4);
  assert.ok(materials.refs.some((a) => a.id === articleIds[3]));
  assert.ok(!materials.refs.some((a) => a.id === articleIds[4]));
  await previewBrief('weekly', '2026-10-26');
  assert.equal(captured, '');
});

test('进展按报道日期排序，依据、网页与邮件独立归档，清理原始资讯后仍可读', async () => {
  const row = await generateBrief('weekly', '2026-10-26');
  const content = row.draft!;
  assert.equal(content.format, 'weekly-review-v1');
  const item = content.items[0];
  assert.deepEqual(
    item.progress?.map((p) => p.date),
    ['2026-10-20', '2026-10-22'],
  );
  assert.equal(item.progress?.[0].evidence[0].excerpt, '宣布启动试点');
  assert.equal(item.sources.length, 4);
  assert.ok(captured.includes('progress'));
  assert.ok(!captured.includes('未来'));
  await db.delete(articles);
  await db.delete(events);
  const archived = briefContentSchema.parse((await db.select().from(briefs))[0].draft);
  assert.deepEqual(archived.items[0].progress, item.progress);
  const html = renderEmail(
    archived,
    'https://example.invalid/brief',
    'https://example.invalid/cancel',
    { kind: 'weekly', date: '2026-10-26' },
  );
  assert.ok(html.includes('本周进展'));
  assert.ok(html.includes('10.20'));
  assert.ok(html.includes('依据1'));
  assert.ok(!html.includes('一周进程'));
  const web = renderToStaticMarkup(
    createElement(PeriodBrief, {
      content: archived,
      kind: 'weekly',
      date: '2026-10-26',
      industries: [{ id: 'finance', name: '金融', sections: ['行业监管'] }],
    }),
  );
  assert.ok(web.includes('本周进展'));
  assert.ok(web.includes('宣布启动试点'));
  assert.ok(web.includes('报道'));
  assert.ok(!web.includes('一周进程'));
});

test('拒绝跨事件、跨周、虚构及重复依据，不将重复报道列为新增进展', async () => {
  const materials = await weeklyMaterials(range, 60, 16);
  const valid = { text: '试点启动', developmentIds: [developmentIds[1]] };
  const check = (other: { text: string; developmentIds: string[] }) =>
    weeklyProgress(eventId, [valid, other], materials, range);
  assert.throws(() => check({ text: '计划', developmentIds: [developmentIds[0]] }), /范围/);
  assert.throws(() => check({ text: '未来', developmentIds: [developmentIds[3]] }), /范围/);
  assert.throws(() => check({ text: '伪造', developmentIds: [randomUUID()] }), /无效/);
  assert.throws(() => check({ text: '重复拆分', developmentIds: [developmentIds[1]] }), /重复/);
  assert.throws(
    () =>
      weeklyProgress(
        randomUUID(),
        [valid, { text: '名单', developmentIds: [developmentIds[2]] }],
        materials,
        range,
      ),
    /无效/,
  );
  const copied = {
    ...materials.developments.find((d) => d.id === developmentIds[1])!,
    id: randomUUID(),
    article_id: articleIds[3],
    happened_at: new Date('2026-10-23T02:00:00Z'),
  };
  assert.throws(
    () =>
      weeklyProgress(
        eventId,
        [valid, { text: '重复报道', developmentIds: [copied.id] }],
        { ...materials, developments: [...materials.developments, copied] },
        range,
      ),
    /重复报道/,
  );
  const combined = weeklyProgress(
    eventId,
    [
      { text: '合并同一变化的多次报道', developmentIds: [developmentIds[1], copied.id] },
      { text: '名单公布', developmentIds: [developmentIds[2]] },
    ],
    { ...materials, developments: [...materials.developments, copied] },
    range,
  );
  assert.equal(combined[0].date, '2026-10-20');
  assert.equal(combined[0].endDate, '2026-10-23');
  assert.throws(() => weeklyProgress(eventId, [valid], materials, range), /至少/);
});

test('模型引用伪造进展时拒绝落库；单次变化允许无进展列表', async () => {
  const response = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const body = await (await response(...args)).json();
    const written = JSON.parse(body.choices[0].message.content);
    written.items[0].progress[0].developmentIds = [randomUUID()];
    body.choices[0].message.content = JSON.stringify(written);
    return new Response(JSON.stringify(body));
  };
  await assert.rejects(generateBrief('weekly', '2026-10-26'), /无效/);
  assert.equal((await db.select().from(briefs)).length, 0);
  globalThis.fetch = async (...args) => {
    const body = await (await response(...args)).json();
    const written = JSON.parse(body.choices[0].message.content);
    written.items[0].progress = [];
    body.choices[0].message.content = JSON.stringify(written);
    return new Response(JSON.stringify(body));
  };
  const row = await generateBrief('weekly', '2026-10-26');
  assert.deepEqual(row.draft?.items[0].progress, []);
});
