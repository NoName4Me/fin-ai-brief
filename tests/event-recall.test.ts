import { saveSettings, syncModelSettings } from './model-settings-fixture.ts';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, db } from '../src/server/db.ts';
import { events } from '../src/server/schema.ts';
import { migrate } from '../scripts/migrate.ts';
import { defaultSettings } from '../src/server/types.ts';

import { importArticle } from '../src/server/collect.ts';
import { processArticle, rankEventCandidates } from '../src/server/process.ts';
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
test('本期事件在80条更新后仍被召回，跨期事件不进入单篇分析', async () => {
  await syncModelSettings();
  const now = new Date('2026-11-06T12:00:00+08:00').getTime();
  const [old] = await db
    .insert(events)
    .values({
      industryId: 'ai',
      title: 'Anthropic完成630亿美元北极星融资',
      summary: '黑石为Anthropic安排630亿美元算力融资。',
      section: '资本与项目',
      score: 80,
      assessment,
      occurredAt: new Date(now - 3600_000),
      updatedAt: new Date(now - 3600_000),
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
      occurredAt: new Date(now - 86400_000),
      updatedAt: new Date(now - 86400_000),
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
  await syncModelSettings();
  const now = new Date('2026-11-06T12:00:00+08:00').getTime();
  const [old] = await db
    .insert(events)
    .values({
      industryId: 'ai',
      title: 'Anthropic完成630亿美元融资',
      summary: '黑石安排630亿美元融资。',
      section: '资本与项目',
      score: 80,
      assessment,
      occurredAt: new Date(now - 3600_000),
    })
    .returning();
  const [article] = await importArticle({
    sourceName: '媒体',
    title: '融资条件后续披露',
    excerpt: 'Anthropic完成630亿美元融资。新增披露贷款需要设备残值支持。',
    url: 'https://example.invalid/followup',
    publishedAt: new Date(now).toISOString(),
  });
  const knownFact = {
    statement: 'Anthropic完成630亿美元融资。',
    status: 'confirmed',
    entities: ['Anthropic'],
  };
  const yesterday = new Date(now - 86400_000);
  const [priorArticle] = await importArticle({
    sourceName: '媒体',
    title: old.title,
    excerpt: old.summary,
    url: 'https://example.invalid/original-financing',
    publishedAt: yesterday.toISOString(),
  });
  await pool.query(
    `INSERT INTO event_developments(event_id,article_id,fact_hash,facts,happened_at)
     VALUES($1,$2,'prior-fact',$3,$4)`,
    [
      old.id,
      priorArticle.id,
      JSON.stringify([{ ...knownFact, evidence: '历史原文', evidenceIds: ['S1'] }]),
      yesterday,
    ],
  );
  const priorItem = { eventId: old.id, title: old.title, summary: old.summary };
  await pool.query(
    `INSERT INTO briefs(kind,period_date,published,published_at)
     VALUES('daily',($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,$2,$1)`,
    [
      yesterday,
      JSON.stringify({
        title: '往期日报',
        highlights: ['全期要览'],
        items: [priorItem, { eventId: null, title: '无关报道', summary: '无关内容' }],
      }),
    ],
  );
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    assert.equal(
      input.candidates.find((candidate: { id: string }) => candidate.id === old.id).knownFacts,
      undefined,
    );
    assert.equal(input.previousCoverage, undefined);
    return new Response(
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
  };
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

test('低分候选被过滤，原始关联标题仍可保护正文改写后的同事件', async () => {
  await syncModelSettings();
  const now = new Date('2026-11-06T12:00:00+08:00').getTime();
  const [linked] = await db
    .insert(events)
    .values({
      industryId: 'ai',
      title: 'zzzz unrelated normalized title',
      summary: 'zzzz unrelated normalized summary',
      section: '资本与项目',
      score: 80,
      assessment,
      occurredAt: new Date(now - 3600_000),
    })
    .returning();
  const [priorArticle] = await importArticle({
    sourceName: '媒体',
    title: 'Anthropic完成630亿美元算力融资',
    excerpt: '历史材料',
    url: 'https://example.invalid/recall-original-title',
    publishedAt: new Date(now - 3600_000).toISOString(),
  });
  await pool.query("UPDATE articles SET event_id=$1,state='processed' WHERE id=$2", [
    linked.id,
    priorArticle.id,
  ]);
  for (let i = 0; i < 15; i++)
    await db.insert(events).values({
      industryId: 'ai',
      title: `yyyy unrelated event ${i}`,
      summary: 'yyyy unrelated summary',
      section: '工具与开源',
      score: 80,
      assessment,
      occurredAt: new Date(now),
    });
  const [article] = await importArticle({
    sourceName: '媒体',
    title: 'Anthropic完成630亿美元算力融资',
    excerpt: 'qqqq 完全改写后的正文。\n免责声明：本文不构成投资建议。',
    url: 'https://example.invalid/recall-rewritten',
    publishedAt: new Date(now).toISOString(),
  });
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    assert.equal(input.candidates.length, 1);
    assert.equal(input.candidates[0].id, linked.id);
    assert.ok(
      !input.article.passages.some((passage: { text: string }) =>
        passage.text.includes('免责声明'),
      ),
    );
    return new Response(
      JSON.stringify({
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                relevant: false,
                reason: '测试仅验证召回，不做收录',
              }),
            },
          },
        ],
      }),
    );
  };
  await processArticle(article.id);
  assert.equal(
    (await pool.query('SELECT state FROM articles WHERE id=$1', [article.id])).rows[0].state,
    'ignored',
  );
});

test('关闭召回优化时维持最多12条全量候选的原行为', () => {
  const candidates = Array.from({ length: 15 }, (_, index) => ({
    id: String(index),
    title: `zzzz event ${index}`,
    summary: 'zzzz summary',
  }));
  const article = { title: 'qqqq title', excerpt: 'qqqq excerpt' };
  assert.equal(
    rankEventCandidates(article, candidates, {
      enabled: false,
      minSimilarity: 0.2,
    }).length,
    12,
  );
  assert.equal(
    rankEventCandidates(article, candidates, {
      enabled: true,
      minSimilarity: 0.03,
    }).length,
    0,
  );
});
