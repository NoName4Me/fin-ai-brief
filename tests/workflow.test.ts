import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/server/db.ts';
import { z } from 'zod';
import { modelUsage, modelJSON } from '../src/server/model.ts';
import { migrate } from '../scripts/migrate.ts';
import {
  articles,
  events,
  briefs,
  modelCalls,
  deliveries,
  subscriptions,
} from '../src/server/schema.ts';
import { defaultSettings } from '../src/server/types.ts';
import { getSettings, saveSettings } from '../src/server/settings.ts';
import { generateLegacyBrief as generateBrief, publishBrief } from '../src/server/briefs.ts';
import { listPublished, publishedBrief } from '../src/server/publication.ts';
import { importArticle } from '../src/server/collect.ts';
import { processArticle } from '../src/server/process.ts';
import { subscribe, unsubscribe, unsubscribeToken } from '../src/server/subscriptions.ts';
import { ids, fixtureContent } from './fixtures.ts';
const testAssessment = Object.fromEntries(
  ['relevance', 'impact', 'timeliness', 'actionability', 'novelty'].map((k) => [
    k,
    { score: 4, reason: '材料提供具体依据' },
  ]),
) as import('../src/server/editorial.ts').Assessment;
const originalFetch = globalThis.fetch;
const testUrl = process.env.DATABASE_URL;
if (!testUrl || !/_test$/.test(new URL(testUrl).pathname))
  throw new Error('测试必须连接独立 _test 数据库，请配置 .data/test.env');
before(async () => {
  await migrate();
  process.env.LLM_API_KEY = 'test-only';
  process.env.LLM_BASE_URL = 'http://model.invalid/v1';
  process.env.LLM_MODEL = 'test-model';
  process.env.APP_SECRET = 'test-only-secret-longer-than-32-characters';
});
after(async () => {
  globalThis.fetch = originalFetch;
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE processing_steps,collection_runs,source_hosts,deliveries,subscriptions,briefs,articles,events,model_calls,login_attempts,sessions,sources CASCADE',
  );
  await saveSettings({
    ...defaultSettings,
    sections: [...new Set(fixtureContent().items.map((i) => i.section))].map((name) => ({
      name,
      minItems: 0,
      maxItems: 10,
      budget: 3000,
    })),
    autoPublish: false,
    dailyEnabled: false,
    weeklyEnabled: false,
    monthlyEnabled: false,
  });
  process.env.MODEL_CALLS_ENABLED = 'true';
  process.env.MAIL_ENABLED = 'false';
  const c = fixtureContent();
  for (const item of c.items) {
    await db.insert(events).values({
      id: item.eventId,
      industryId: item.industryId,
      title: item.title,
      summary: item.summary,
      section: item.section,
      score: 80,
      assessment: testAssessment,
      tags: [],
      occurredAt: new Date('2026-10-21T12:00:00Z'),
    });
    await db.insert(articles).values({
      sourceName: '测试来源',
      industryId: item.industryId,
      url: item.sources[0].url,
      title: item.title,
      excerpt: item.summary,
      publishedAt: new Date('2026-10-21T12:00:00Z'),
      state: 'processed',
      eventId: item.eventId,
    });
  }
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                title: '测试简报',
                overview: c.overview,
                items: c.items.map(({ eventId, title, summary }) => ({ eventId, title, summary })),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 20 },
      }),
    );
});
test('关闭自动发布时草稿不出现在任何正式简报读取中；审核后可见', async () => {
  const row = await generateBrief('daily', '2026-10-22');
  assert.ok(row.draft);
  assert.equal(row.published, null);
  assert.deepEqual(await listPublished(), []);
  assert.equal(await publishedBrief(row.id), undefined);
  await publishBrief(row.id);
  assert.equal((await listPublished()).length, 1);
  assert.equal((await publishedBrief(row.id))?.content?.title, '测试简报');
  await assert.rejects(() => publishBrief(row.id), /没有待发布/);
});
test('重新生成待审稿时原正式版保持可见', async () => {
  await saveSettings({ ...defaultSettings, autoPublish: true });
  const row = await generateBrief('daily', '2026-10-22');
  await saveSettings({
    ...defaultSettings,
    sections: [...new Set(fixtureContent().items.map((i) => i.section))].map((name) => ({
      name,
      minItems: 0,
      maxItems: 10,
      budget: 3000,
    })),
    autoPublish: false,
    dailyEnabled: false,
    weeklyEnabled: false,
    monthlyEnabled: false,
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ ...fixtureContent(), title: '新草稿' }) },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  await saveSettings({ ...(await getSettings()), editorialPrompt: '修订后的写作要求' });
  const next = await generateBrief('daily', '2026-10-22');
  assert.equal(next.id, row.id);
  assert.equal(next.draft?.title, '新草稿');
  assert.equal((await publishedBrief(row.id))?.content?.title, '测试简报');
});
test('发布方式在任务开始时读取，中途修改不改变当前任务', async () => {
  const response = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    await saveSettings({ ...defaultSettings, autoPublish: true });
    return response(...args);
  };
  const row = await generateBrief('daily', '2026-10-22');
  assert.ok(row.draft);
  assert.equal(row.published, null);
});
test('无效事件引用拒绝写入；模型回执保留token数', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                title: '错引用',
                overview: { ai: 'x' },
                items: [
                  { eventId: '99999999-9999-4999-8999-999999999999', title: 'x', summary: 'y' },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 4 },
      }),
    );
  await assert.rejects(() => generateBrief('daily', '2026-10-22'), /无效或重复/);
  assert.equal((await db.select().from(briefs)).length, 0);
  const calls = await db.select().from(modelCalls);
  assert.equal(calls[0].inputTokens, 5);
});
test('付费调用开关和每日额度在请求前生效', async () => {
  let called = 0;
  const response = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    called++;
    return response(...args);
  };
  process.env.MODEL_CALLS_ENABLED = 'false';
  await assert.rejects(() => generateBrief('daily', '2026-10-22'), /开启模型/);
  assert.equal(called, 0);
  process.env.MODEL_CALLS_ENABLED = 'true';
  await saveSettings({ ...defaultSettings, autoPublish: false, modelDailyLimit: 1 });
  await generateBrief('daily', '2026-10-22');
  await generateBrief('daily', '2026-10-22'); // 相同输入复用成功结果，即使当天额度已满。
  assert.equal(called, 1);
  await saveSettings({ ...(await getSettings()), editorialPrompt: '修改输入以验证新请求额度' });
  await assert.rejects(() => generateBrief('daily', '2026-10-22'), /已达上限/);
  assert.equal(called, 1);
  assert.deepEqual(await modelUsage(), { used: 1, limit: 1, remaining: 0 });
  await saveSettings({ ...(await getSettings()), modelDailyLimit: 2 });
  await generateBrief('daily', '2026-10-22');
  assert.equal(called, 2);
  assert.deepEqual(await modelUsage(), { used: 2, limit: 2, remaining: 0 });
});
test('模型配置缺失不记调用回执，HTTP失败计入额度且不自动重试', async () => {
  const key = process.env.LLM_API_KEY;
  delete process.env.LLM_API_KEY;
  try {
    await assert.rejects(() => generateBrief('daily', '2026-10-22'), /LLM_API_KEY/);
    assert.equal((await modelUsage()).used, 0);
  } finally {
    process.env.LLM_API_KEY = key;
  }
  let called = 0;
  globalThis.fetch = async () => {
    called++;
    return new Response('', { status: 401 });
  };
  await saveSettings({ ...defaultSettings, autoPublish: false, modelDailyLimit: 1 });
  await assert.rejects(() => generateBrief('daily', '2026-10-22'), /HTTP 401/);
  await assert.rejects(() => generateBrief('daily', '2026-10-22'), /已达上限/);
  assert.equal(called, 1);
  assert.deepEqual(await modelUsage(), { used: 1, limit: 1, remaining: 0 });
  assert.equal((await db.select().from(modelCalls))[0].state, 'failed');
});
test('手工导入按规范化URL去重，模型归入已有事件', async () => {
  await saveSettings({ ...(await getSettings()), reviewEnabled: false });
  const input = {
    title: '新的进展',
    url: 'https://example.com/news?utm_source=a',
    excerpt: '新的事实',
    sourceName: '测试',
    industryId: 'ai',
    publishedAt: '2026-10-21T20:00:00+08:00',
  };
  const [row] = await importArticle(input);
  assert.equal((await importArticle({ ...input, url: 'https://example.com/news' })).length, 0);
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                relevant: true,
                title: '合并后的事件',
                summary: '保留前情和新进展',
                section: 'AI 模型',
                score: 82,
                assessment: testAssessment,
                tags: [],
                facts: [
                  { statement: '摘要', evidence: input.excerpt, status: 'claim', entities: [] },
                ],
                existingEventId: ids[4],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    );
  await processArticle(row.id);
  const [article] = await db.select().from(articles).where(eq(articles.id, row.id));
  assert.equal(article.eventId, ids[4]);
  assert.equal(article.state, 'processed');
  assert.equal((await db.select().from(events)).length, 8);
});
test('订阅去重不泄露凭据或修改偏好，退订幂等', async () => {
  const token = await subscribe({ email: 'Test@Example.com', kinds: ['daily'] });
  assert.ok(token);
  assert.equal(await subscribe({ email: 'test@example.com', kinds: ['monthly'] }), null);
  const [row] = await db.select().from(subscriptions);
  assert.deepEqual(row.kinds, ['daily']);
  assert.notEqual(row.tokenHash, token);
  assert.equal(unsubscribeToken(row.id), token);
  await unsubscribe(token);
  await unsubscribe(token);
  assert.equal((await db.select().from(subscriptions))[0].active, false);
  await assert.rejects(() => unsubscribe('bad'), /无效/);
});
test('首次发布创建投递，重出不重发，即使投递记录已清理', async () => {
  process.env.MAIL_ENABLED = 'true';
  await subscribe({ email: 'one@example.com', kinds: ['daily'] });
  const token = await subscribe({ email: 'two@example.com', kinds: ['daily'] });
  await unsubscribe(token!);
  const row = await generateBrief('daily', '2026-10-22');
  await publishBrief(row.id);
  assert.equal((await db.select().from(deliveries)).length, 1);
  await db.delete(deliveries);
  await generateBrief('daily', '2026-10-22');
  await publishBrief(row.id);
  assert.equal((await db.select().from(deliveries)).length, 0);
  await saveSettings({ ...defaultSettings, autoPublish: true });
  await generateBrief('daily', '2026-10-22');
  assert.equal((await db.select().from(deliveries)).length, 0);
});

test('关闭发信时发布的简报，之后重出也不会补发', async () => {
  await subscribe({ email: 'one@example.com', kinds: ['daily'] });
  const row = await generateBrief('daily', '2026-10-22');
  await publishBrief(row.id);
  process.env.MAIL_ENABLED = 'true';
  await generateBrief('daily', '2026-10-22');
  await publishBrief(row.id);
  assert.equal((await db.select().from(deliveries)).length, 0);
});

test('补刊任务忽略自动发布设置，审核发布及后续重出均不自动推送', async () => {
  await saveSettings({ ...defaultSettings, autoPublish: true });
  process.env.MAIL_ENABLED = 'true';
  await subscribe({ email: 'one@example.com', kinds: ['daily'] });
  const result = await generateBrief('daily', '2026-10-22', undefined, { backfill: true });
  assert.ok('id' in result);
  const [row] = await db.select().from(briefs);
  assert.ok(row.draft);
  assert.equal(row.published, null);
  assert.equal(row.autoMail, false);
  assert.equal((await db.select().from(deliveries)).length, 0);
  await generateBrief('daily', '2026-10-22', undefined, { backfill: true });
  assert.equal((await db.select().from(briefs))[0].autoMail, false);
  await publishBrief(row.id);
  assert.ok((await publishedBrief(row.id))?.content);
  assert.equal((await db.select().from(deliveries)).length, 0);
  await generateBrief('daily', '2026-10-22');
  assert.equal((await db.select().from(deliveries)).length, 0);
});

test('时段内有待处理资讯时不生成不完整简报，也不调用模型', async () => {
  await importArticle({
    title: '待处理',
    url: 'https://example.invalid/pending',
    excerpt: '摘要',
    sourceName: '测试',
    industryId: 'finance',
    publishedAt: '2026-10-21T20:00:00+08:00',
  });
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('不应调用');
  };
  await assert.rejects(() => generateBrief('daily', '2026-10-22'), /仍有资讯待处理/);
  assert.equal(called, false);
});

test('期号按类型和年度独立分配，并发发布不重复，修订不换号', async () => {
  const content = fixtureContent();
  const rows = await db
    .insert(briefs)
    .values([
      { kind: 'daily', periodDate: '2026-10-21', draft: content },
      { kind: 'daily', periodDate: '2026-10-22', draft: content },
      { kind: 'weekly', periodDate: '2026-10-19', draft: content },
      { kind: 'daily', periodDate: '2025-12-31', draft: content },
    ])
    .returning();
  const assigned = await Promise.all(rows.slice(0, 2).map((row) => publishBrief(row.id)));
  assert.deepEqual(assigned.map((r) => r.issueNumber).sort(), [1, 2]);
  assert.equal((await publishBrief(rows[2].id)).issueNumber, 1);
  assert.equal((await publishBrief(rows[3].id)).issueNumber, 1);
  await db.update(briefs).set({ draft: content }).where(eq(briefs.id, rows[0].id));
  assert.equal((await publishBrief(rows[0].id)).issueNumber, assigned[0].issueNumber);
});
test('媒体无关材料仅返回不相关决定即可忽略，不要求分类或建立事件', async () => {
  const [row] = await importArticle({
    title: '非AI消费新闻',
    url: 'https://example.invalid/unrelated-media',
    excerpt: '与关注行业无关的材料',
    sourceName: '测试媒体',
    industryId: 'ai',
    publishedAt: '2026-10-22T07:00:00+08:00',
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          { finish_reason: 'stop', message: { content: JSON.stringify({ relevant: false }) } },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  await processArticle(row.id);
  const [article] = await db.select().from(articles).where(eq(articles.id, row.id));
  assert.equal(article.state, 'ignored');
  assert.equal(article.eventId, null);
  assert.equal((await db.select().from(events)).length, 8);
});

test('AI本期标题允许36字，超出时拒绝覆盖已生成稿', async () => {
  let title = '金'.repeat(36);
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ ...fixtureContent(), title }) },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  const row = await generateBrief('daily', '2026-10-22');
  assert.equal(row.draft?.title, title);
  title += '融';
  await saveSettings({ ...(await getSettings()), editorialPrompt: '变更写作要求，验证标题边界' });
  await assert.rejects(() => generateBrief('daily', '2026-10-22'), /36字/);
  assert.equal(
    (await db.select().from(briefs).where(eq(briefs.id, row.id)))[0].draft?.title,
    '金'.repeat(36),
  );
});

function modelReply(value: unknown) {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
      usage: { prompt_tokens: 30, completion_tokens: 40 },
    }),
  );
}
test('事实必须引用真实摘要片段，拒绝证据外推并保留失败结果', async () => {
  const [row] = await importArticle({
    title: '监管公告',
    url: 'https://example.invalid/evidence',
    excerpt: '机构公布试点计划。',
    sourceName: '本地测试',
    industryId: 'finance',
    publishedAt: '2026-10-22T07:00:00+08:00',
  });
  globalThis.fetch = async () =>
    modelReply({
      relevant: true,
      title: '监管公告',
      summary: '试点计划',
      section: '行业监管',
      score: 80,
      assessment: testAssessment,
      tags: [],
      existingEventId: null,
      facts: [{ statement: '全面实施', evidence: '已全面实施', status: 'confirmed', entities: [] }],
    });
  await assert.rejects(processArticle(row.id), /事实依据不在来源摘要/);
  assert.equal(
    (await db.select().from(articles).where(eq(articles.id, row.id)))[0].state,
    'pending',
  );
  const calls = await pool.query(
    'SELECT state,response,input_tokens FROM model_calls WHERE subject=$1',
    [`article:${row.id}`],
  );
  assert.equal(calls.rows[0].state, 'failed');
  assert.equal(calls.rows[0].input_tokens, 30);
  assert.ok(calls.rows[0].response);
});
test('复核失败后仅重试复核，主处理结果复用；不同意合并则保留独立低分原文', async () => {
  const excerpt = '机构公布试点计划。';
  const [row] = await importArticle({
    title: '监管试点',
    url: 'https://example.invalid/review',
    excerpt,
    sourceName: '本地测试',
    industryId: 'finance',
    publishedAt: '2026-10-22T07:00:00+08:00',
  });
  let main = 0,
    review = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.messages[0].content.includes('独立复核')) {
      review++;
      return review === 1
        ? new Response('', { status: 503 })
        : modelReply({ approved: false, reason: '没有足够依据判为同一事件' });
    }
    main++;
    return modelReply({
      relevant: true,
      title: '综合标题',
      summary: '模型摘要',
      section: '行业监管',
      score: 85,
      assessment: testAssessment,
      tags: [],
      existingEventId: ids[0],
      facts: [{ statement: excerpt, evidence: excerpt, status: 'planned', entities: ['机构'] }],
      needsReview: true,
      novelty: 'update',
    });
  };
  await assert.rejects(processArticle(row.id), /HTTP 503/);
  await processArticle(row.id);
  assert.equal(main, 1);
  assert.equal(review, 2);
  const [saved] = await db.select().from(articles).where(eq(articles.id, row.id));
  assert.equal(saved.state, 'processed');
  assert.notEqual(saved.eventId, ids[0]);
  assert.match(saved.reviewNote!, /没有足够依据/);
  const [event] = await db.select().from(events).where(eq(events.id, saved.eventId!));
  assert.equal(event.score, 0);
  assert.equal(event.summary, excerpt);
  const steps = await pool.query(
    'SELECT stage,state,call_id FROM processing_steps WHERE subject=$1',
    [`article:${row.id}`],
  );
  assert.equal(steps.rows.find((s) => s.stage === 'analyze').state, 'succeeded');
  assert.ok(steps.rows.find((s) => s.stage === 'analyze').call_id);
});
test('重复报道只挂接证据，不重写事件或制造实时新增提示', async () => {
  await saveSettings({ ...(await getSettings()), reviewEnabled: false });
  const [row] = await importArticle({
    title: '转载材料',
    url: 'https://example.invalid/repeat-fact',
    excerpt: '同一公告。',
    sourceName: '转载测试',
    industryId: 'finance',
    publishedAt: '2026-10-22T07:00:00+08:00',
  });
  const [before] = await db.select().from(events).where(eq(events.id, ids[0]));
  globalThis.fetch = async () =>
    modelReply({
      relevant: true,
      title: '不应覆盖的标题',
      summary: '不应覆盖的摘要',
      section: '行业监管',
      score: 80,
      assessment: testAssessment,
      tags: [],
      existingEventId: ids[0],
      facts: [
        { statement: '同一公告。', evidence: '同一公告。', status: 'announced', entities: [] },
      ],
      novelty: 'duplicate',
    });
  await processArticle(row.id);
  const [after] = await db.select().from(events).where(eq(events.id, ids[0]));
  assert.deepEqual(after, before);
  assert.equal((await pool.query('SELECT * FROM news_changes')).rowCount, 0);
});
test('实时变更按游标续接，保留筛选条件并一次返回多个事件', async () => {
  const { newsSnapshot, newsChanges } = await import('../src/server/publication.ts');
  const initial = await newsSnapshot('finance');
  await pool.query('INSERT INTO news_changes(event_id) VALUES($1),($2),($3)', [
    ids[0],
    ids[1],
    ids[4],
  ]);
  const batch = await newsChanges(initial.cursor, 'finance');
  assert.equal(batch.items.length, 2);
  assert.ok(batch.items.every((e) => e.industryId === 'finance'));
  assert.equal((await newsChanges(batch.cursor, 'finance')).items.length, 0);
  const only = await newsChanges(initial.cursor, 'ai');
  assert.equal(only.items.length, 1);
});
test('模型超时后无需人工放行，重试重新请求并计入次数', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new Error('socket reset');
    return modelReply(fixtureContent());
  };
  await assert.rejects(generateBrief('daily', '2026-10-22'), /socket reset/);
  await generateBrief('daily', '2026-10-22');
  assert.equal(calls, 2);
  const log = await pool.query('SELECT state,request_key FROM model_calls ORDER BY created_at');
  assert.equal(log.rows[0].state, 'failed');
  assert.equal(log.rows[0].request_key, null);
  assert.equal(log.rows[1].state, 'succeeded');
});
test('生成前预览不请求模型，资料变更后拒绝使用旧预览发起调用', async () => {
  const { previewLegacyBrief: previewBrief } = await import('../src/server/briefs.ts');
  let calls = 0;
  const response = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls++;
    return response(...args);
  };
  const preview = await previewBrief('daily', '2026-10-22');
  assert.equal(preview.cached, false);
  assert.equal(calls, 0);
  await saveSettings({ ...(await getSettings()), editorialPrompt: '已改变的写作要求' });
  await assert.rejects(generateBrief('daily', '2026-10-22', preview.key), /重新预览/);
  assert.equal(calls, 0);
  await generateBrief('daily', '2026-10-22');
  assert.equal((await previewBrief('daily', '2026-10-22')).cached, true);
});

test('简报标题上限配置同时约束提示词和结果，保留既有长标题', async () => {
  let title = '金'.repeat(48),
    prompt = '';
  globalThis.fetch = async (_url, init) => {
    prompt = JSON.parse(String(init?.body)).messages[0].content;
    return modelReply({ ...fixtureContent(), title });
  };
  await saveSettings({ ...(await getSettings()), briefTitleMaxLength: 48 });
  const brief = await generateBrief('daily', '2026-10-22');
  assert.match(prompt, /不超过48字/);
  assert.equal(brief.draft?.title, title);
  title += '融';
  await saveSettings({ ...(await getSettings()), editorialPrompt: '重新核验配置上限' });
  await assert.rejects(generateBrief('daily', '2026-10-22'), /48字/);
  assert.equal(
    (await db.select().from(briefs).where(eq(briefs.id, brief.id)))[0].draft?.title,
    '金'.repeat(48),
  );
  await saveSettings({ ...(await getSettings()), briefTitleMaxLength: 20 });
  title = '金融简报';
  await generateBrief('daily', '2026-10-22');
  assert.match(prompt, /不超过20字/);
  await assert.rejects(saveSettings({ ...(await getSettings()), briefTitleMaxLength: 0 }));
});

test('金融篇幅容差内原样接受，AI摘要保持原有长度', async () => {
  const content = fixtureContent();
  content.items[0].summary = '金'.repeat(154);
  content.overview.finance = '融'.repeat(132);
  content.items.find((i) => i.industryId === 'ai')!.summary = 'AI'.repeat(150);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return modelReply(content);
  };
  const saved = await generateBrief('daily', '2026-10-22');
  assert.equal(saved.draft!.items[0].summary, content.items[0].summary);
  assert.equal(saved.draft!.overview.finance, content.overview.finance);
  assert.equal(saved.draft!.items.find((i) => i.industryId === 'ai')!.summary.length, 300);
  assert.equal(calls, 1);
});

test('重试耗尽的资讯保留失败记录，不阻塞同周期简报生成', async () => {
  const [row] = await importArticle({
    title: '失败资讯',
    url: 'https://example.invalid/exhausted',
    excerpt: '摘要',
    sourceName: '测试',
    industryId: 'ai',
    publishedAt: '2026-10-21T20:00:00+08:00',
  });
  await pool.query("UPDATE articles SET state='failed' WHERE id=$1", [row.id]);
  const brief = await generateBrief('daily', '2026-10-22');
  assert.ok(brief.draft);
  assert.equal(
    (await pool.query('SELECT state FROM articles WHERE id=$1', [row.id])).rows[0].state,
    'failed',
  );
});

test('并发分析相同事实的两条来源，只建立一个事件', async () => {
  await saveSettings({ ...(await getSettings()), reviewEnabled: false });
  const input = {
    title: '并发相同公告',
    excerpt: '测试企业发布全新模型。',
    sourceName: '测试',
    industryId: 'ai',
    publishedAt: '2026-10-22T07:00:00+08:00',
  };
  const [a] = await importArticle({ ...input, url: 'https://example.invalid/concurrent-a' });
  const [b] = await importArticle({
    ...input,
    sourceName: '另一来源',
    url: 'https://example.invalid/concurrent-b',
  });
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async () => {
    if (++started === 2) release();
    await gate;
    return modelReply({
      relevant: true,
      title: input.title,
      summary: input.excerpt,
      section: 'AI 模型',
      score: 80,
      assessment: testAssessment,
      tags: [],
      existingEventId: null,
      novelty: 'new',
      facts: [
        {
          statement: input.excerpt,
          evidence: input.excerpt,
          status: 'announced',
          entities: ['测试企业'],
        },
      ],
    });
  };
  await Promise.all([processArticle(a.id), processArticle(b.id)]);
  const rows = await pool.query('SELECT state,event_id FROM articles WHERE id=ANY($1::uuid[])', [
    [a.id, b.id],
  ]);
  assert.ok(rows.rows.every((r) => r.state === 'processed'));
  assert.equal(rows.rows[0].event_id, rows.rows[1].event_id);
  assert.equal((await db.select().from(events)).length, 9);
});

test('并发更新同一事件时检测过期摘要，重试重新召回而不覆盖新结果', async () => {
  await saveSettings({ ...(await getSettings()), reviewEnabled: false });
  const base = { sourceName: '测试', industryId: 'ai', publishedAt: '2026-10-22T07:00:00+08:00' };
  const [a] = await importArticle({
    ...base,
    title: '进展甲',
    excerpt: '新增事实甲。',
    url: 'https://example.invalid/update-a',
  });
  const [b] = await importArticle({
    ...base,
    title: '进展乙',
    excerpt: '新增事实乙。',
    url: 'https://example.invalid/update-b',
  });
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (++started === 2) release();
    await gate;
    const previous = input.candidates.find((c: { id: string }) => c.id === ids[4]);
    return modelReply({
      relevant: true,
      title: '持续更新事件',
      summary: previous.summary + input.article.excerpt,
      section: 'AI 模型',
      score: 80,
      assessment: testAssessment,
      tags: [],
      existingEventId: ids[4],
      novelty: 'update',
      facts: [
        {
          statement: input.article.excerpt,
          evidence: input.article.excerpt,
          status: 'announced',
          entities: [],
        },
      ],
    });
  };
  const results = await Promise.allSettled([processArticle(a.id), processArticle(b.id)]);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  const retry = results[0].status === 'rejected' ? a.id : b.id;
  await processArticle(retry);
  const saved = (await db.select().from(events).where(eq(events.id, ids[4])))[0];
  assert.match(saved.summary, /新增事实甲/);
  assert.match(saved.summary, /新增事实乙/);
  assert.equal(started, 3);
});

test('完全相同的并发生成共用一次模型请求，不消耗重试次数', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return modelReply(fixtureContent());
  };
  const results = await Promise.all([
    generateBrief('daily', '2026-10-22'),
    generateBrief('daily', '2026-10-22'),
    generateBrief('daily', '2026-10-22'),
  ]);
  assert.equal(calls, 1);
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  const log = await pool.query('SELECT state,reused_count FROM model_calls');
  assert.equal(log.rowCount, 1);
  assert.equal(log.rows[0].reused_count, 2);
});

test('简报提示词给出实际行业键的JSON示例，避免模型照抄行业ID占位符', async () => {
  const response = globalThis.fetch;
  let prompt = '';
  globalThis.fetch = async (...args) => {
    prompt = JSON.parse(String(args[1]?.body)).messages[0].content;
    return response(...args);
  };
  await generateBrief('daily', '2026-10-22');
  assert.ok(prompt.includes('"overview":{"finance":'), '概览格式必须使用实际finance键');
  assert.ok(prompt.includes('"ai":'), '概览格式必须使用实际ai键');
  assert.ok(!prompt.includes('overview:{行业ID:string}'), '不能把行业ID占位符当作格式示例');
});

test('行业概览格式错误时指出错误键、字段路径及允许值', async () => {
  globalThis.fetch = async () =>
    modelReply({ ...fixtureContent(), overview: { industryId: 'finance' } });
  await assert.rejects(generateBrief('daily', '2026-10-22'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /模型返回未配置的行业/);
    assert.match(error.message, /industryId/);
    assert.match(error.message, /finance/);
    assert.match(error.message, /ai/);
    assert.match(error.message, /overview/);
    return true;
  });
  assert.equal((await db.select().from(briefs)).length, 0);
});

test('拒绝漏写已入选行业的概览，未入选行业可省略', async () => {
  const content = fixtureContent();
  globalThis.fetch = async () => modelReply({ ...content, overview: { ai: 'AI要情' } });
  await assert.rejects(generateBrief('daily', '2026-10-22'), /缺少finance行业概览/);
  assert.equal((await db.select().from(briefs)).length, 0);
  globalThis.fetch = async () =>
    modelReply({
      ...content,
      overview: { ai: 'AI要情' },
      items: content.items.filter((item) => item.industryId === 'ai'),
    });
  const saved = await generateBrief('daily', '2026-10-22');
  assert.deepEqual(saved.draft?.overview, { ai: 'AI要情' });
});

test('超出容差只压缩对应段落，保留其余内容、标题和事件顺序', async () => {
  const content = fixtureContent();
  content.items[0].summary = '金'.repeat(170);
  content.items[1].summary = '融'.repeat(150);
  content.overview.finance = '概'.repeat(139);
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    if (calls === 1) return modelReply(content);
    const request = JSON.parse(String(init?.body));
    const input = JSON.parse(request.messages[1].content);
    assert.deepEqual(
      input.segments.map((s: { id: string }) => s.id).sort(),
      [`summary:${ids[0]}`, 'overview:finance'].sort(),
    );
    const summary = input.segments.find((s: { id: string }) => s.id === `summary:${ids[0]}`);
    assert.equal(summary.currentLength, 170);
    assert.equal(summary.maxLength, 140);
    assert.equal(summary.acceptedMaxLength, 154);
    assert.match(request.messages[0].content, /数字|事实/);
    return modelReply({
      segments: input.segments.map((s: { id: string }) => ({
        id: s.id,
        text: s.id === 'overview:finance' ? '压缩后概览' : '压缩后摘要',
      })),
    });
  };
  const saved = await generateBrief('daily', '2026-10-22');
  assert.equal(calls, 2);
  assert.equal(saved.draft!.title, content.title);
  assert.equal(saved.draft!.items[0].summary, '压缩后摘要');
  assert.equal(saved.draft!.overview.finance, '压缩后概览');
  assert.deepEqual(
    saved.draft!.items.slice(1).map((i) => i.summary),
    content.items.slice(1).map((i) => i.summary),
  );
  assert.deepEqual(
    saved.draft!.items.map((i) => i.eventId),
    content.items.map((i) => i.eventId),
  );
});

test('压缩失败后重试复用初稿，修正成功前不落库或发布', async () => {
  const content = fixtureContent();
  content.items[0].summary = '金'.repeat(170);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return modelReply(content);
    return modelReply({
      segments: [{ id: `summary:${ids[0]}`, text: calls === 2 ? '金'.repeat(155) : '完成压缩' }],
    });
  };
  await assert.rejects(generateBrief('daily', '2026-10-22'), /155.*154/);
  assert.equal((await db.select().from(briefs)).length, 0);
  const { previewLegacyBrief: previewBrief } = await import('../src/server/briefs.ts');
  assert.equal((await previewBrief('daily', '2026-10-22')).cached, false);
  assert.equal(calls, 2);
  const saved = await generateBrief('daily', '2026-10-22');
  assert.equal((await previewBrief('daily', '2026-10-22')).cached, true);
  assert.equal(calls, 3);
  assert.equal(saved.draft!.items[0].summary, '完成压缩');
  const log = await pool.query('SELECT reused_count FROM model_calls ORDER BY created_at LIMIT 1');
  assert.equal(log.rows[0].reused_count, 1);
});

test('篇幅配置持久化并约束生成，支持关闭容差及拒绝无效配置', async () => {
  await saveSettings({
    ...(await getSettings()),
    financeSummaryMaxLength: 100,
    financeOverviewMaxLength: 80,
    briefLengthTolerancePercent: 0,
  });
  const settings = await getSettings();
  assert.equal(settings.financeSummaryMaxLength, 100);
  assert.equal(settings.financeOverviewMaxLength, 80);
  assert.equal(settings.briefLengthTolerancePercent, 0);
  const content = fixtureContent();
  content.items[0].summary = '金'.repeat(101);
  content.overview.finance = '概'.repeat(81);
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    if (calls === 1) {
      assert.match(request.messages[0].content, /不超过100字/);
      return modelReply(content);
    }
    const input = JSON.parse(request.messages[1].content);
    assert.equal(
      input.segments.find((s: { id: string }) => s.id === 'overview:finance').maxLength,
      80,
    );
    return modelReply({
      segments: input.segments.map((s: { id: string }) => ({ id: s.id, text: '压缩完成' })),
    });
  };
  await generateBrief('daily', '2026-10-22');
  assert.equal(calls, 2);
  for (const invalid of [
    { financeSummaryMaxLength: 0 },
    { financeOverviewMaxLength: 1001 },
    { briefLengthTolerancePercent: -1 },
    { briefLengthTolerancePercent: 51 },
  ]) {
    await assert.rejects(saveSettings({ ...settings, ...invalid }));
  }
});

test('压缩响应不得遗漏、重复或改写未指定段落', async () => {
  const content = fixtureContent();
  content.items[0].summary = '金'.repeat(155);
  const target = { id: `summary:${ids[0]}`, text: '合格摘要' };
  let baseCalls = 0;
  let patch: { id: string; text: string }[] = [];
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (!input.segments) {
      baseCalls++;
      return modelReply(content);
    }
    return modelReply({ segments: patch });
  };
  for (const invalid of [
    [],
    [target, target],
    [{ ...target, id: `summary:${ids[1]}` }],
    [target, { id: 'overview:finance', text: '不应修改' }],
  ]) {
    patch = invalid;
    await assert.rejects(generateBrief('daily', '2026-10-22'));
    assert.equal((await db.select().from(briefs)).length, 0);
  }
  assert.equal(baseCalls, 1);
});

test('容差变化会使旧生成预览失效', async () => {
  const { previewLegacyBrief: previewBrief } = await import('../src/server/briefs.ts');
  const preview = await previewBrief('daily', '2026-10-22');
  await saveSettings({ ...(await getSettings()), briefLengthTolerancePercent: 20 });
  await assert.rejects(generateBrief('daily', '2026-10-22', preview.key), /重新预览/);
});

test('各任务统一使用环境默认模型，旧的分任务模型设置不再生效', async () => {
  await saveSettings({
    ...(await getSettings()),
    processingModel: 'legacy-process',
    reviewModel: 'legacy-review',
    briefModel: 'legacy-brief',
  });
  const models: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    models.push(body.model);
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ok: true }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  };
  for (const purpose of ['article', 'review', 'brief'])
    await modelJSON(
      purpose,
      'single-model-' + purpose,
      { test: purpose },
      z.object({ ok: z.boolean() }),
    );
  assert.deepEqual(models, ['test-model', 'test-model', 'test-model']);
});
