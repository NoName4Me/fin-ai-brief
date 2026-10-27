import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { migrate } from '../scripts/migrate.ts';
import { db, pool } from '../src/server/db.ts';
import { articles, events, sources } from '../src/server/schema.ts';
import { defaultSettings, briefContentSchema } from '../src/server/types.ts';
import { saveSettings, getSettings } from '../src/server/settings.ts';
import {
  assessmentSchema,
  weightedRating,
  displayRating,
  rotationRules,
  keywordMatches,
  type Assessment,
} from '../src/server/editorial.ts';
import { generateBrief, publishBrief, previewBrief } from '../src/server/briefs.ts';
import { processArticle } from '../src/server/process.ts';
import { importArticle } from '../src/server/collect.ts';
import { publishedBrief } from '../src/server/publication.ts';
import { rangeFor, duePeriods } from '../src/server/periods.ts';
import { renderEmail } from '../src/server/mail-template.ts';
import { Rating } from '../src/components/rating.tsx';
import { subscribe } from '../src/server/subscriptions.ts';
import { runGeneration, requestGeneration } from '../src/server/generation-requests.ts';

if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('必须使用独立_test数据库');
const originalFetch = globalThis.fetch;
const assessment: Assessment = Object.fromEntries(
  ['relevance', 'impact', 'timeliness', 'actionability', 'novelty'].map((k) => [
    k,
    { score: 4, reason: '材料提供可核对的具体依据' },
  ]),
) as Assessment;
const topAssessment: Assessment = { ...assessment, relevance: { score: 5, reason: '直接涉及AI' } };
const reply = (value: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
  );
type DailyInput = {
  selected: { id: string; rating: number }[];
  rotationMaterials: { name: string; events: { id: string }[] }[];
};
function written(input: DailyInput) {
  return {
    title: 'AI能力与治理进展',
    items: input.selected.map((e) => ({
      eventId: e.id,
      title: '工具发布更新',
      summary: '机构公布更新计划，保留使用条件。',
    })),
    highlights: input.selected
      .filter((e) => e.rating >= 4.3)
      .slice(0, 5)
      .map((e) => ({ eventId: e.id, text: '工具发布更新' })),
    rotations: [] as { name: string; text: string; eventIds: string[] }[],
  };
}
function inputFrom(init?: RequestInit) {
  const body = JSON.parse(String(init?.body));
  return JSON.parse(body.messages[1].content) as DailyInput;
}
before(async () => {
  await migrate();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE edition_runs,processing_steps,model_calls,brief_requests,collection_runs,source_hosts,deliveries,subscriptions,briefs,articles,events,sources CASCADE',
  );
  await saveSettings({ ...defaultSettings, autoPublish: false, rotationsEnabled: false });
  process.env.MODEL_CALLS_ENABLED = 'true';
  process.env.MAIL_ENABLED = 'false';
  process.env.LLM_API_KEY = 'test-only';
  process.env.LLM_BASE_URL = 'http://model.invalid/v1';
  process.env.LLM_MODEL = 'test';
  process.env.APP_SECRET = 'test-secret-at-least-thirty-two-characters';
  globalThis.fetch = async (_url, init) => reply(written(inputFrom(init)));
});
after(async () => {
  globalThis.fetch = originalFetch;
  await pool.end();
});
test('复核收到已采集的来源与发布时间，避免将漏传元数据误判为证据不足', async () => {
  await saveSettings({ ...(await getSettings()), reviewEnabled: true });
  const [article] = await importArticle({
    title: '官方公布AI工具更新',
    url: 'https://example.invalid/metadata-review',
    excerpt: '官方发布AI工具并开放代码。',
    sourceName: '工具官方博客',
    publishedAt: '2026-10-21T12:00:00Z',
    publishedPrecision: 'time',
  });
  let reviewInput: { article: { source?: string; url?: string; publishedAt?: string; publishedPrecision?: string } } | undefined;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.messages[0].content.includes('独立复核')) {
      reviewInput = JSON.parse(body.messages[1].content);
      const complete = reviewInput?.article.source === '工具官方博客'
        && reviewInput.article.publishedAt === '2026-10-21T12:00:00.000Z'
        && reviewInput.article.url === 'https://example.invalid/metadata-review';
      return reply({ approved: complete, reason: complete ? '已有来源与报道时间，事实限定正确' : '没有来源与报道时间，无法批准' });
    }
    return reply({ relevant: true, title: '官方公布AI工具更新', summary: '官方发布AI工具并开放代码。',
      section: '工具与开源', assessment: topAssessment, tags: [], existingEventId: null,
      facts: [{ statement: '发布AI工具并开放代码', evidence: '发布AI工具并开放代码', status: 'announced', entities: [] }],
      novelty: 'new', needsReview: true,
    });
  };
  await processArticle(article.id);
  const saved = await pool.query('SELECT e.score,a.review_note FROM articles a JOIN events e ON e.id=a.event_id WHERE a.id=$1',[article.id]);
  assert.equal(saved.rows[0].score,86,'已有来源和时间不应因复核请求漏传而被归零');
  assert.equal(reviewInput?.article.publishedPrecision,'time');
});
async function seed(
  date = '2026-10-21T12:00:00Z',
  a = topAssessment,
  section = '工具与开源',
  industryId = 'ai',
) {
  const id = randomUUID();
  const articleId = randomUUID();
  const score = Math.round(weightedRating(a) * 20);
  await db.insert(events).values({
    id,
    industryId,
    title: '工具发布更新',
    summary: '机构公布更新计划',
    section,
    score,
    assessment: a,
    tags: ['开源'],
    occurredAt: new Date(date),
  });
  await db.insert(articles).values({
    id: articleId,
    eventId: id,
    industryId,
    title: '工具发布更新',
    excerpt: '机构公布更新计划，保留使用条件。',
    url: `https://example.invalid/${articleId}`,
    sourceName: '测试来源',
    publishedAt: new Date(date),
    state: 'processed',
    assessment: a,
  });
  await pool.query(
    'INSERT INTO event_developments(event_id,article_id,fact_hash,facts,happened_at,editorial) VALUES($1,$2,$3,$4,$5,$6)',
    [
      id,
      articleId,
      id,
      JSON.stringify([
        { statement: '机构公布更新计划', evidence: '机构公布更新计划', status: 'announced' },
      ]),
      date,
      JSON.stringify({
        title: '工具发布更新',
        summary: '机构公布更新计划',
        section,
        score,
        assessment: a,
        tags: ['开源'],
      }),
    ],
  );
  return { id, articleId };
}
test('加权总分与半星展示分开，原始4.3门槛不受舍入影响', () => {
  assert.equal(weightedRating(topAssessment), 4.3);
  assert.equal(weightedRating(assessment), 4);
  assert.equal(displayRating(4.3), 4.5);
  assert.equal(displayRating(3.4), 3.5);
  assert.equal(
    assessmentSchema.safeParse({ ...assessment, impact: { score: 6, reason: '错误' } }).success,
    false,
  );
  const html = renderToStaticMarkup(createElement(Rating, { value: 4.3 }));
  assert.match(html, /4.5分/);
  assert.match(html, /50%/);
  assert.equal((html.match(/<svg/g) ?? []).length, 5);
});
test('每天08:00连续覆盖，含周末且不再安排周月报', () => {
  for (const date of ['2026-10-24', '2026-10-25', '2026-10-26']) {
    const range = rangeFor('daily', date, '08:00');
    assert.equal(range.end.getTime() - range.start.getTime(), 86400000);
    assert.deepEqual(
      duePeriods(range.end, { ...defaultSettings, startDate: '2026-01-01' }).map((p) => p.kind),
      ['daily'],
    );
  }
});
test('隔周排期按基准所在周计算，关键词命中只作线索', () => {
  assert.equal(rotationRules('2026-10-28', '2026-10-30')[1].scheduled, true);
  assert.equal(rotationRules('2026-11-04', '2026-10-30')[1].scheduled, false);
  assert.deepEqual(keywordMatches('银行大模型公布MCP方案', '技术：大模型；MCP\n资本：AI融资'), [
    '大模型',
    'MCP',
  ]);
});
test('不同旧行业来源共享事件归组，保存五维分数与标签', async () => {
  const existing = await seed('2026-10-21T12:00:00Z', assessment, '政策与监管', 'finance');
  const [article] = await importArticle({
    title: 'AI监管进展',
    url: 'https://example.invalid/new',
    excerpt: '监管机构公布AI管理要求。',
    sourceName: '科技来源',
    industryId: 'ai',
    publishedAt: '2026-10-21T13:00:00Z',
  });
  globalThis.fetch = async () =>
    reply({
      relevant: true,
      title: 'AI监管进展',
      summary: '监管机构公布AI管理要求。',
      section: '政策与监管',
      assessment: topAssessment,
      tags: ['金融'],
      existingEventId: existing.id,
      facts: [
        {
          statement: '公布AI管理要求',
          evidence: '公布AI管理要求',
          status: 'announced',
          entities: [],
        },
      ],
      novelty: 'update',
    });
  await processArticle(article.id);
  const saved = await pool.query('SELECT event_id,assessment FROM articles WHERE id=$1', [
    article.id,
  ]);
  assert.equal(saved.rows[0].event_id, existing.id);
  assert.deepEqual(saved.rows[0].assessment, topAssessment);
  const event = await pool.query('SELECT score,industry_id,tags FROM events WHERE id=$1', [
    existing.id,
  ]);
  assert.equal(event.rows[0].score, 86);
  assert.equal(event.rows[0].industry_id, 'ai');
  assert.deepEqual(event.rows[0].tags, ['金融']);
});
test('普通金融资讯可被AI关联检查淘汰，不产生事件', async () => {
  const [article] = await importArticle({
    title: '普通金融新闻',
    url: 'https://example.invalid/finance',
    excerpt: '某机构公布一般业务进展。',
    sourceName: '金融来源',
    industryId: 'finance',
    publishedAt: '2026-10-21T13:00:00Z',
  });
  globalThis.fetch = async () => reply({ relevant: false, reason: '与AI无实质关联' });
  await processArticle(article.id);
  assert.equal(
    (await pool.query('SELECT state,industry_id FROM articles WHERE id=$1', [article.id])).rows[0]
      .state,
    'ignored',
  );
  assert.equal((await pool.query('SELECT count(*)::int n FROM events')).rows[0].n, 0);
});
test('显式重处理更新已有事件评分和编辑快照，但不制造新事实进展', async () => {
  const old = await seed('2026-10-21T12:00:00Z', assessment);
  await pool.query("UPDATE articles SET state='pending' WHERE id=$1", [old.articleId]);
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    return input.article
      ? reply({
          relevant: true,
          title: '工具发布更新',
          summary: '机构公布更新计划，保留使用条件。',
          section: '工具与开源',
          assessment: topAssessment,
          tags: ['开源'],
          existingEventId: old.id,
          novelty: 'duplicate',
          facts: [
            {
              statement: '机构公布更新计划',
              evidence: '机构公布更新计划',
              status: 'announced',
              entities: [],
            },
          ],
        })
      : reply(written(input));
  };
  await processArticle(old.articleId, randomUUID());
  const saved = await generateBrief('daily', '2026-10-22');
  assert.equal(saved.draft!.items[0].rating, 4.3);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM event_developments WHERE event_id=$1', [old.id]))
      .rows[0].n,
    1,
  );
});
test('旧未评分事件不能把重新处理的首条新流程资料吞成重复报道', async () => {
  const legacy = await seed('2026-10-21T12:00:00Z', assessment, '工具与开源', 'finance');
  await pool.query('UPDATE events SET assessment=NULL WHERE id=$1', [legacy.id]);
  await pool.query(
    "UPDATE articles SET state='pending',assessment=NULL,processing_version='facts-v1' WHERE id=$1",
    [legacy.articleId],
  );
  await pool.query(
    "UPDATE event_developments SET editorial=editorial-'assessment' WHERE event_id=$1",
    [legacy.id],
  );
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (input.article) {
      const old = input.candidates.find((e: { id: string }) => e.id === legacy.id);
      return reply({
        relevant: true,
        title: '工具发布更新',
        summary: '机构公布更新计划，保留使用条件。',
        section: '工具与开源',
        assessment: topAssessment,
        tags: ['开源'],
        existingEventId: old?.id ?? null,
        novelty: old ? 'duplicate' : 'new',
        facts: [
          {
            statement: '机构公布更新计划',
            evidence: '机构公布更新计划',
            status: 'announced',
            entities: [],
          },
        ],
      });
    }
    return reply(written(input));
  };
  await processArticle(legacy.articleId);
  const saved = await generateBrief('daily', '2026-10-22');
  assert.equal(
    saved.draft!.items.length,
    1,
    '重新处理后应存在带五维评分的本期进展，而不是旧事件吞掉新评分',
  );
  assert.equal(saved.draft!.items[0].rating, 4.3);
});
test('日报按当期事实快照取材，包含起点排除终点及未来状态', async () => {
  const keep = await seed('2026-10-21T00:00:00Z');
  await seed('2026-10-22T00:00:00Z');
  await pool.query(
    "UPDATE events SET title='未来标题',summary='未来状态',score=0,occurred_at='2026-10-28T00:00:00Z' WHERE id=$1",
    [keep.id],
  );
  globalThis.fetch = async (_url, init) => {
    assert.ok(!String(init?.body).includes('未来状态'));
    return reply(written(inputFrom(init)));
  };
  const saved = await generateBrief('daily', '2026-10-22');
  assert.equal(saved.draft!.items.length, 1);
  assert.equal(saved.draft!.items[0].eventId, keep.id);
  assert.equal(saved.draft!.items[0].rating, 4.3);
});
test('人工审核阻断网页和投递，发布后同步记录且修订不重复发送', async () => {
  await seed();
  process.env.MAIL_ENABLED = 'true';
  await subscribe({ email: 'qa@example.invalid', kinds: ['daily'] });
  const saved = await generateBrief('daily', '2026-10-22');
  assert.equal(await publishedBrief(saved.id), undefined);
  assert.equal((await pool.query('SELECT count(*)::int n FROM deliveries')).rows[0].n, 0);
  assert.equal(
    (await pool.query("SELECT status FROM edition_runs WHERE section='工具与开源'")).rows[0].status,
    'ready',
  );
  await publishBrief(saved.id);
  assert.ok(await publishedBrief(saved.id));
  assert.equal((await pool.query('SELECT count(*)::int n FROM deliveries')).rows[0].n, 1);
  assert.equal(
    (await pool.query("SELECT status FROM edition_runs WHERE section='工具与开源'")).rows[0].status,
    'published',
  );
  await saveSettings({ ...(await getSettings()), autoPublish: true });
  await generateBrief('daily', '2026-10-22');
  assert.equal((await pool.query('SELECT count(*)::int n FROM deliveries')).rows[0].n, 1);
});
test('正常空刊不调用模型，栏目空缺与未排期分别记录', async () => {
  process.env.MODEL_CALLS_ENABLED = 'false';
  globalThis.fetch = async () => {
    throw new Error('不应调用模型');
  };
  const saved = await generateBrief('daily', '2026-10-22');
  assert.equal(saved.draft!.items.length, 0);
  const logs = await pool.query('SELECT section,status FROM edition_runs');
  assert.equal(logs.rows.length, 9);
  assert.equal(logs.rows.find((r) => r.section === '政策与监管').status, 'skipped');
  assert.equal(logs.rows.find((r) => r.section === '一周观察').status, 'unscheduled');
});
test('来源采集异常不能当作正常无内容，不发布空刊', async () => {
  await db.insert(sources).values({
    name: '异常来源',
    url: 'https://example.invalid/rss',
    format: 'rss',
    industryId: 'ai',
    enabled: true,
    lastError: 'HTTP 503',
  });
  await assert.rejects(generateBrief('daily', '2026-10-22'), /存在异常/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM briefs')).rows[0].n, 0);
  const logs = (await pool.query('SELECT status FROM edition_runs')).rows;
  assert.equal(logs.filter((r) => r.status === 'error').length, 6);
  assert.equal(logs.filter((r) => r.status === 'unscheduled').length, 3);
});
test('评审拒绝的零分事件不会因五维分数高重新入刊', async () => {
  const event = await seed();
  await pool.query(
    "UPDATE event_developments SET editorial=jsonb_set(editorial,'{score}','0'::jsonb) WHERE event_id=$1",
    [event.id],
  );
  const saved = await generateBrief('daily', '2026-10-22');
  assert.equal(saved.draft!.items.length, 0);
});
test('栏目预算、要览门槛、重复和遗漏事件均校验，失败不落正式稿', async () => {
  await seed();
  await saveSettings({ ...(await getSettings()), autoPublish: true });
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (!input.selected)
      return reply({
        items: input.sections.flatMap(
          (s: { items: { eventId: string; title: string; summary: string }[] }) =>
            s.items.map((i) => ({ ...i, summary: '字'.repeat(201) })),
        ),
      });
    const v = written(input);
    v.items[0].summary = '字'.repeat(201);
    return reply(v);
  };
  await assert.rejects(generateBrief('daily', '2026-10-22'), /200字预算/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM briefs')).rows[0].n, 0);
  await pool.query('DELETE FROM model_calls');
  globalThis.fetch = async (_url, init) => {
    const v = written(inputFrom(init));
    v.items.push(v.items[0]);
    return reply(v);
  };
  await assert.rejects(generateBrief('daily', '2026-10-22'), /无效或重复/);
});
test('超预算时系统只压缩对应栏目，保留其他内容并复用初稿与压缩缓存', async () => {
  await seed('2026-10-21T12:00:00Z', topAssessment, '工具与开源');
  await seed('2026-10-21T13:00:00Z', topAssessment, '工具与开源');
  const policy = await seed('2026-10-21T14:00:00Z', topAssessment, '政策与监管');
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (input.selected) {
      const v = written(input);
      v.items = v.items.map((i) => ({
        ...i,
        summary: i.eventId === policy.id ? '政策摘要保持原样。' : '字'.repeat(120),
      }));
      return reply(v);
    }
    assert.equal(input.sections.length, 1);
    assert.equal(input.sections[0].name, '工具与开源');
    return reply({
      items: input.sections[0].items.map((i: { eventId: string; title: string }) => ({
        ...i,
        summary: '机构公布工具更新。',
      })),
    });
  };
  const saved = await generateBrief('daily', '2026-10-22');
  assert.equal(calls, 2);
  assert.equal(
    saved.draft!.items.find((i) => i.eventId === policy.id)!.summary,
    '政策摘要保持原样。',
  );
  const tools = saved.draft!.items.filter((i) => i.section === '工具与开源');
  assert.ok(tools.reduce((n, i) => n + [...(i.title + i.summary)].length, 0) <= 200);
  assert.equal((await previewBrief('daily', '2026-10-22')).cached, true);
  await generateBrief('daily', '2026-10-22');
  assert.equal(calls, 2);
});
test('不满栏目下限仍出短刊，网页邮件共享星级、要览和来源', async () => {
  await seed();
  const saved = await generateBrief('daily', '2026-10-22');
  const content = saved.draft!;
  assert.equal(content.format, 'ai-daily-v1');
  assert.equal(content.items.length, 1);
  assert.equal(content.highlights?.length, 1);
  const html = renderEmail(
    content,
    'https://example.invalid/issue',
    'https://example.invalid/unsubscribe',
  );
  assert.match(html, /今日要览/);
  assert.match(html, /4.5\/5/);
  assert.match(html, /工具与开源/);
  assert.ok(!html.includes('金融要情'));
  assert.ok(!html.includes('AI要情'));
  assert.equal(briefContentSchema.safeParse(content).success, true);
});
test('预览只读，规则变化使生成确认失效', async () => {
  await seed();
  const preview = await previewBrief('daily', '2026-10-22');
  assert.equal((await pool.query('SELECT count(*)::int n FROM model_calls')).rows[0].n, 0);
  await saveSettings({
    ...(await getSettings()),
    sections: defaultSettings.sections.map((s) => ({ ...s, budget: s.budget + 10 })),
  });
  await assert.rejects(generateBrief('daily', '2026-10-22', preview.key), /重新预览/);
});
test('暂停周月报的新请求与已排队生成', async () => {
  await assert.rejects(requestGeneration('weekly', '2026-10-26'), /只生成AI日报/);
  assert.deepEqual(await runGeneration(randomUUID(), { kind: 'monthly', date: '2026-11-01' }), {
    skipped: true,
    reason: '周月报已暂停',
  });
});
test('新版补刊始终待审且不自动推送，普通修订也不补发', async () => {
  await seed();
  await saveSettings({ ...(await getSettings()), autoPublish: true });
  process.env.MAIL_ENABLED = 'true';
  await subscribe({ email: 'backfill@example.invalid', kinds: ['daily'] });
  const result = await runGeneration(randomUUID(), {
    kind: 'daily',
    date: '2026-10-22',
    backfill: true,
  });
  assert.ok('id' in result);
  if (!('id' in result)) return;
  assert.ok(result.draft);
  assert.equal(result.published, null);
  assert.equal(result.autoMail, false);
  await publishBrief(result.id);
  await generateBrief('daily', '2026-10-22');
  assert.equal((await pool.query('SELECT count(*)::int n FROM deliveries')).rows[0].n, 0);
});
test('重处理后的日报更新仍遵循人工审核开关', async () => {
  await seed();
  process.env.MAIL_ENABLED = 'true';
  await subscribe({ email: 'review-replay@example.invalid', kinds: ['daily'] });
  const result = await runGeneration(randomUUID(), {
    kind: 'daily',
    date: '2026-10-22',
    backfill: true,
    publishWithoutMail: true,
  });
  assert.ok('draft' in result);
  if (!('draft' in result)) return;
  assert.ok(result.draft);
  assert.equal(result.published, null);
  assert.equal((await pool.query('SELECT count(*)::int n FROM deliveries')).rows[0].n, 0);
});
test('周一轮动可以引用七天材料，普通日报仍只引用一天材料', async () => {
  await saveSettings({ ...(await getSettings()), rotationsEnabled: true });
  const first = await seed('2026-10-20T12:00:00Z');
  const second = await seed('2026-10-22T12:00:00Z');
  const today = await seed('2026-10-25T12:00:00Z');
  globalThis.fetch = async (_url, init) => {
    const input = inputFrom(init);
    assert.equal(input.selected.length, 1);
    assert.equal(input.selected[0].id, today.id);
    const v = written(input);
    v.rotations = [
      {
        name: '一周观察',
        text: '三项进展均涉及工具和使用条件。',
        eventIds: [first.id, second.id, today.id],
      },
    ];
    return reply(v);
  };
  const saved = await generateBrief('daily', '2026-10-26');
  assert.equal(saved.draft!.rotations?.[0].sources.length, 3);
  assert.equal(
    (await pool.query("SELECT status FROM edition_runs WHERE section='一周观察'")).rows[0].status,
    'ready',
  );
});
