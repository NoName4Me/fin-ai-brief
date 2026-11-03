import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, db } from '../src/server/db.ts';
import { events } from '../src/server/schema.ts';
import { migrate } from '../scripts/migrate.ts';
import { defaultSettings } from '../src/server/types.ts';
import { saveSettings } from '../src/server/settings.ts';
import { importArticle } from '../src/server/collect.ts';
import { processArticle } from '../src/server/process.ts';
if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('必须使用独立_test数据库');
const originalFetch = globalThis.fetch;
const assessment = Object.fromEntries(
  defaultSettings.ratingRules.map((r) => [r.id, { score: 4, reason: '来源可核对' }]),
);
before(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE briefs,articles,events,processing_steps,model_calls CASCADE');
  await saveSettings({ ...defaultSettings, reviewEnabled: false });
  process.env.MODEL_CALLS_ENABLED = 'true';
  process.env.LLM_API_KEY = 'test';
  process.env.LLM_BASE_URL = 'http://model.invalid/v1';
  process.env.LLM_MODEL = 'test';
});
after(async () => {
  globalThis.fetch = originalFetch;
  await pool.end();
});
test('14天内的旧融资事件在80条更新后仍被召回，重复报道不新增进展，超期事件不进入候选', async () => {
  const now = Date.now();
  const [old] = await db
    .insert(events)
    .values({
      industryId: 'ai',
      title: 'Anthropic完成630亿美元北极星融资',
      summary: '黑石为Anthropic安排630亿美元算力融资。',
      section: '资本与项目',
      score: 80,
      assessment,
      occurredAt: new Date(now - 2 * 86400_000),
      updatedAt: new Date(now - 2 * 86400_000),
    })
    .returning();
  const [expired] = await db
    .insert(events)
    .values({
      industryId: 'ai',
      title: old.title,
      summary: old.summary,
      section: old.section,
      score: 80,
      assessment,
      occurredAt: new Date(now - 15 * 86400_000),
      updatedAt: new Date(now - 15 * 86400_000),
    })
    .returning();
  for (let i = 0; i < 85; i++)
    await db.insert(events).values({
      industryId: 'ai',
      title: `工具发布${i}`,
      summary: '工具支持新功能。',
      section: '工具与开源',
      score: 80,
      assessment,
      occurredAt: new Date(now),
      updatedAt: new Date(now),
    });
  const [article] = await importArticle({
    sourceName: '媒体',
    title: '在座各位AI，都是垃圾',
    excerpt: '黑石联合银行为Anthropic安排630亿美元算力融资，北极星交易已经交割。',
    url: 'https://example.invalid/financing',
    publishedAt: new Date(now).toISOString(),
  });
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    assert.ok(input.candidates.some((c: { id: string }) => c.id === old.id));
    assert.ok(!input.candidates.some((c: { id: string }) => c.id === expired.id));
    return new Response(
      JSON.stringify({
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                relevant: true,
                title: old.title,
                summary: old.summary,
                section: old.section,
                assessment,
                existingEventId: old.id,
                novelty: 'duplicate',
                facts: [
                  {
                    statement: 'Anthropic获630亿美元算力融资。',
                    evidenceIds: ['S1'],
                    status: 'confirmed',
                    entities: ['Anthropic'],
                  },
                ],
                newFactIndexes: [],
                needsReview: false,
                conflict: false,
              }),
            },
          },
        ],
      }),
    );
  };
  await processArticle(article.id);
  const row = (await pool.query('SELECT event_id FROM articles WHERE id=$1', [article.id])).rows[0];
  assert.equal(row.event_id, old.id);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM event_developments WHERE article_id=$1', [
        article.id,
      ])
    ).rows[0].n,
    0,
  );
});

test('后续报道保存完整原文事实，但事件进展只写入新增条件', async () => {
  const now = Date.now();
  const [old] = await db
    .insert(events)
    .values({
      industryId: 'ai',
      title: 'Anthropic完成630亿美元融资',
      summary: '黑石安排630亿美元融资。',
      section: '资本与项目',
      score: 80,
      assessment,
      occurredAt: new Date(now - 86400_000),
    })
    .returning();
  const [article] = await importArticle({
    sourceName: '媒体',
    title: '融资条件后续披露',
    excerpt: 'Anthropic完成630亿美元融资。新增披露贷款需要设备残值支持。',
    url: 'https://example.invalid/followup',
    publishedAt: new Date(now).toISOString(),
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                relevant: true,
                title: 'Anthropic融资补充披露设备残值支持',
                summary: '新增披露贷款需要设备残值支持。',
                section: '资本与项目',
                assessment,
                existingEventId: old.id,
                novelty: 'update',
                facts: [
                  {
                    statement: 'Anthropic完成630亿美元融资。',
                    evidenceIds: ['S1'],
                    status: 'confirmed',
                    entities: ['Anthropic'],
                  },
                  {
                    statement: '贷款需要设备残值支持。',
                    evidenceIds: ['S2'],
                    status: 'announced',
                    entities: ['Anthropic'],
                  },
                ],
                newFactIndexes: [1],
                needsReview: false,
                conflict: false,
              }),
            },
          },
        ],
      }),
    );
  await processArticle(article.id);
  const stored = (await pool.query('SELECT facts FROM articles WHERE id=$1', [article.id])).rows[0];
  assert.equal(stored.facts.length, 2);
  const development = (
    await pool.query('SELECT facts FROM event_developments WHERE article_id=$1', [article.id])
  ).rows[0];
  assert.deepEqual(
    development.facts.map((f: { statement: string }) => f.statement),
    ['贷款需要设备残值支持。'],
  );
});
