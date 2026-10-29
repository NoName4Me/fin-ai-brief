import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../scripts/migrate.ts';
import { db, pool } from '../src/server/db.ts';
import { sources } from '../src/server/schema.ts';
import { saveSourceConfig, toggleSource } from '../src/server/source-config.ts';
import { verifySource, advertisedFeeds } from '../src/server/source-verification.ts';
import { defaultSettings } from '../src/server/types.ts';
import { saveSettings } from '../src/server/settings.ts';
import { processArticle } from '../src/server/process.ts';
import { importArticle } from '../src/server/collect.ts';
import { weeklyMaterials } from '../src/server/weekly-review.ts';
if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('必须使用独立_test数据库');
const originalFetch = globalThis.fetch;
before(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE sources,articles,events,processing_steps,model_calls CASCADE');
  await saveSettings({ ...defaultSettings, reviewEnabled: false });
  process.env.MODEL_CALLS_ENABLED = 'true';
  process.env.MAIL_ENABLED = 'false';
  process.env.LLM_API_KEY = 'test';
  process.env.LLM_BASE_URL = 'http://model.invalid/v1';
  process.env.LLM_MODEL = 'test';
});
after(async () => {
  globalThis.fetch = originalFetch;
  await pool.end();
});
const config = {
  name: '候选公众号',
  originAddress: '公众号“候选”',
  url: null,
  format: 'manual',
  sections: [],
  priority: 'P1',
  verificationStatus: 'pending',
  verificationNote: '',
  notes: '',
  intervalMinutes: 60,
  autoInterval: false,
  minIntervalMinutes: 60,
  maxIntervalMinutes: 240,
};
test('候选可无采集入口入库，默认关闭且不能绕过验证启用', async () => {
  const row = await saveSourceConfig(undefined, config);
  assert.equal(row.enabled, false);
  assert.equal(row.url, null);
  assert.deepEqual(row.sections, []);
  await assert.rejects(toggleSource(row.id, true), /采集入口/);
  const [technical] = await db
    .insert(sources)
    .values({
      name: '仅技术通过',
      url: 'https://example.invalid/rss',
      format: 'rss',
      industryId: 'ai',
      verificationStatus: 'pending',
    })
    .returning();
  await assert.rejects(toggleSource(technical.id, true), /采集验证/);
  await pool.query("UPDATE sources SET verification_status='approved' WHERE id=$1", [technical.id]);
  await toggleSource(technical.id, true);
  await toggleSource(technical.id, false);
  assert.equal(
    (await pool.query('SELECT enabled FROM sources WHERE id=$1', [technical.id])).rows[0].enabled,
    false,
  );
});
test('移除采集入口会关闭信源并撤销旧验证，非法栏目不能保存', async () => {
  const [row] = await db
    .insert(sources)
    .values({
      name: '现有',
      url: 'https://example.invalid/rss',
      format: 'rss',
      industryId: 'ai',
      verificationStatus: 'approved',
      enabled: true,
      etag: 'old',
    })
    .returning();
  const saved = await saveSourceConfig(row.id, { ...config, name: '现有' });
  assert.equal(saved.enabled, false);
  assert.equal(saved.verificationStatus, 'pending');
  assert.equal(saved.etag, null);
  await assert.rejects(saveSourceConfig(undefined, { ...config, sections: ['不存在的栏目'] }));
});
test('从官网声明发现RSS，保存样本但不导入、不启用，失败也留记录', async () => {
  const row = await saveSourceConfig(undefined, {
    ...config,
    originAddress: 'https://example.invalid/',
  });
  assert.deepEqual(
    advertisedFeeds(
      '<link type="application/rss+xml" href="/feed?a=1&amp;b=2" rel="alternate">',
      'https://example.invalid/',
    ),
    ['https://example.invalid/feed?a=1&b=2'],
  );
  const result = await verifySource(row.id, async (url) =>
    url.endsWith('/')
      ? '<link rel="alternate" type="application/rss+xml" href="/feed">'
      : '<rss version="2.0"><channel><title>来源</title><item><title>AI模型发布</title><link>https://example.invalid/story</link><description>模型新增工具调用能力。</description><pubDate>Mon, 26 Oct 2026 08:00:00 GMT</pubDate></item></channel></rss>',
  );
  assert.equal(result.status, 'approved');
  assert.match(result.note, /AI模型发布/);
  const saved = (await pool.query('SELECT * FROM sources WHERE id=$1', [row.id])).rows[0];
  assert.equal(saved.url, 'https://example.invalid/feed');
  assert.equal(saved.enabled, false);
  assert.equal((await pool.query('SELECT count(*)::int n FROM articles')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM model_calls')).rows[0].n, 0);
  assert.equal(
    (
      await verifySource(row.id, async () => {
        throw new Error('HTTP 403');
      })
    ).status,
    'failed',
  );
  assert.match(
    (await pool.query('SELECT verification_note FROM sources WHERE id=$1', [row.id])).rows[0]
      .verification_note,
    /403/,
  );
  const stale = await verifySource(
    row.id,
    async () =>
      '<rss version="2.0"><channel><title>旧订阅</title><item><title>旧消息</title><link>https://example.invalid/old</link><description>旧摘要</description><pubDate>Sun, 26 Apr 2020 19:35:56 GMT</pubDate></item></channel></rss>',
  );
  assert.equal(stale.status, 'approved');
  await toggleSource(row.id, true);
  const thin = await verifySource(
    row.id,
    async () =>
      '<rss version="2.0"><channel><title>空摘要</title><item><title>AI模型发布</title><link>https://example.invalid/new</link><description>点击查看原文&gt;</description><pubDate>Mon, 26 Oct 2026 08:00:00 GMT</pubDate></item></channel></rss>',
  );
  assert.equal(thin.status, 'approved');
  assert.match(thin.note, /有效摘要不足/);
});
async function processed(configured: string[], chosen: string) {
  const [source] = await db
    .insert(sources)
    .values({
      name: '范围来源',
      url: 'https://example.invalid/feed',
      format: 'rss',
      industryId: 'ai',
      sections: configured,
    })
    .returning();
  const [article] = await importArticle(
    {
      title: 'AI工具发布',
      url: 'https://example.invalid/story',
      excerpt: '发布AI工具并开放代码。',
      publishedAt: '2026-10-26T08:00:00Z',
      sourceName: '范围来源',
    },
    source.id,
  );
  const inputs: { industry: { sections: string[] } }[] = [];
  globalThis.fetch = async (_url, init) => {
    inputs.push(JSON.parse(JSON.parse(String(init?.body)).messages[1].content));
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                relevant: true,
                title: 'AI工具发布',
                summary: '发布AI工具并开放代码。',
                section: chosen,
                assessment: Object.fromEntries(
                  ['relevance', 'impact', 'timeliness', 'actionability', 'novelty'].map((k) => [
                    k,
                    { score: 4, reason: '材料有明确依据' },
                  ]),
                ),
                tags: [],
                existingEventId: null,
                facts: [
                  {
                    statement: '开放代码',
                    evidence: '开放代码',
                    status: 'announced',
                    entities: [],
                  },
                ],
                novelty: 'new',
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    );
  };
  return { source, article, inputs };
}
test('多栏目只处理一次、只允许所选栏目，修改范围后出刊候选同步受限', async () => {
  const { source, article, inputs } = await processed(['技术与模型', '工具与开源'], '工具与开源');
  await processArticle(article.id);
  assert.deepEqual(inputs[0].industry.sections, ['技术与模型', '工具与开源']);
  assert.equal(inputs.length, 1);
  const range = { start: new Date('2026-10-26T00:00:00Z'), end: new Date('2026-10-27T00:00:00Z') };
  assert.equal((await weeklyMaterials(range, 0, 100)).selected.length, 1);
  await pool.query('UPDATE sources SET sections=$2::jsonb WHERE id=$1', [
    source.id,
    JSON.stringify(['政策与监管']),
  ]);
  assert.equal((await weeklyMaterials(range, 0, 100)).selected.length, 0);
  await pool.query("UPDATE sources SET sections='[]'::jsonb WHERE id=$1", [source.id]);
  assert.equal((await weeklyMaterials(range, 0, 100)).selected.length, 1);
});
test('通用来源接收全部栏目，越界栏目输出被拦截', async () => {
  const general = await processed([], '风险与安全');
  await processArticle(general.article.id);
  assert.equal(general.inputs[0].industry.sections.length, 6);
  await pool.query('TRUNCATE sources,articles,events,processing_steps,model_calls CASCADE');
  const restricted = await processed(['政策与监管'], '风险与安全');
  await assert.rejects(processArticle(restricted.article.id), /未配置栏目/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM events')).rows[0].n, 0);
});
