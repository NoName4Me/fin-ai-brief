import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/server/db.ts';
import { modelUsage } from '../src/server/model.ts';
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
import { generateBrief, publishBrief } from '../src/server/briefs.ts';
import { listPublished, publishedBrief } from '../src/server/publication.ts';
import { importArticle } from '../src/server/collect.ts';
import { processArticle } from '../src/server/process.ts';
import { subscribe, unsubscribe, unsubscribeToken } from '../src/server/subscriptions.ts';
import { ids, fixtureContent } from './fixtures.ts';
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
test('邮件投递随发布原子创建、退订者不入队，未开启发信不留历史待发', async () => {
  await subscribe({ email: 'one@example.com', kinds: ['daily'] });
  const token = await subscribe({ email: 'two@example.com', kinds: ['daily'] });
  await unsubscribe(token!);
  const old = await generateBrief('daily', '2026-10-22');
  await publishBrief(old.id);
  assert.equal((await db.select().from(deliveries)).length, 0);
  process.env.MAIL_ENABLED = 'true';
  await generateBrief('daily', '2026-10-22');
  await publishBrief(old.id);
  assert.equal((await db.select().from(deliveries)).length, 1);
  await generateBrief('daily', '2026-10-22');
  await publishBrief(old.id);
  assert.equal((await db.select().from(deliveries)).length, 1);
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
  const { previewBrief } = await import('../src/server/briefs.ts');
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

test('金融简报限定摘要与概览篇幅，AI摘要保留原有长度', async () => {
  let content = fixtureContent();
  content.items.find((i) => i.industryId === 'finance')!.summary = '金'.repeat(141);
  globalThis.fetch = async () => modelReply(content);
  await assert.rejects(generateBrief('daily', '2026-10-22'), /金融摘要不能超过140字/);
  content.items.find((i) => i.industryId === 'finance')!.summary = '金'.repeat(120);
  content.overview.finance = '金'.repeat(121);
  await assert.rejects(generateBrief('daily', '2026-10-22'), /金融概览不能超过120字/);
  content.overview.finance = '金融要情';
  content.items.find((i) => i.industryId === 'ai')!.summary = 'AI'.repeat(150);
  const saved = await generateBrief('daily', '2026-10-22');
  assert.equal(saved.draft!.items.find((i) => i.industryId === 'finance')!.summary.length, 120);
  assert.equal(saved.draft!.items.find((i) => i.industryId === 'ai')!.summary.length, 300);
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
