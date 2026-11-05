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
    assert.deepEqual(
      input.candidates.find((candidate: { id: string }) => candidate.id === old.id).knownFacts,
      [[knownFact]],
    );
    assert.deepEqual(
      input.previousCoverage.map(({ date, ...entry }: { date: string }) => entry),
      [{ items: [priorItem] }],
    );
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

test('初筛只拦截明确排除，异常回退，抽查发现分歧后暂停拦截', async () => {
  const { screeningCohort } = await import('../src/server/article-screening.ts');
  const { articles } = await import('../src/server/schema.ts');
  const now = new Date();
  const start = new Date(now.getTime() - 1000).toISOString();
  const saved = process.env.ARTICLE_SCREENING_TRIAL_START;
  process.env.ARTICLE_SCREENING_TRIAL_START = start;
  let serial = 0;
  const add = async (cohort: 'audit' | 'gate') => {
    let id: string;
    do {
      id = `10000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
    } while (screeningCohort(id, now, start) !== cohort);
    await db.insert(articles).values({
      id,
      industryId: 'ai',
      sourceName: '媒体',
      title: `算力融资 ${serial}`,
      excerpt: '黑石安排630亿美元算力融资。',
      url: `https://example.invalid/screen/${serial}`,
      publishedAt: now,
      createdAt: now,
    });
    return id;
  };
  const response = (content: unknown) =>
    Response.json({
      usage: { prompt_tokens: 5, completion_tokens: 2 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
    });
  const purposes = async (id: string) =>
    (
      await pool.query('SELECT purpose FROM model_calls WHERE subject=$1 ORDER BY created_at', [
        `article:${id}`,
      ])
    ).rows.map(({ purpose }) => purpose);
  try {
    let fail = false;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.max_tokens === 1600) {
        const material = JSON.parse(body.messages[1].content);
        assert.equal(material.candidates, undefined);
        assert.equal(material.previousCoverage, undefined);
        if (fail) throw new DOMException('请求超时', 'TimeoutError');
        return response({ decision: 'exclude', reason: '初筛判为不相关' });
      }
      return response({
        relevant: true,
        title: '黑石安排算力融资',
        summary: '黑石安排630亿美元算力融资。',
        section: '资本与项目',
        assessment,
        existingEventId: null,
        facts: [
          {
            statement: '黑石安排630亿美元算力融资。',
            evidenceIds: ['S1'],
            status: 'confirmed',
            entities: ['黑石'],
          },
        ],
      });
    };
    const gate = await add('gate');
    await processArticle(gate);
    assert.deepEqual(await purposes(gate), ['article-screening']);
    assert.equal(
      (await pool.query('SELECT state FROM articles WHERE id=$1', [gate])).rows[0].state,
      'ignored',
    );

    fail = true;
    const fallback = await add('gate');
    await processArticle(fallback);
    assert.deepEqual(await purposes(fallback), ['article-screening', 'article']);

    fail = false;
    const audit = await add('audit');
    await processArticle(audit);
    assert.deepEqual(await purposes(audit), ['article-screening', 'article']);

    const stopped = await add('gate');
    await processArticle(stopped);
    assert.deepEqual(await purposes(stopped), ['article']);
  } finally {
    if (saved === undefined) delete process.env.ARTICLE_SCREENING_TRIAL_START;
    else process.env.ARTICLE_SCREENING_TRIAL_START = saved;
  }
});
