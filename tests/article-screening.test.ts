import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../scripts/migrate.ts';
import { pool } from '../src/server/db.ts';
import { getQueue, enqueuePendingArticles } from '../src/server/queue.ts';
import { defaultSettings } from '../src/server/types.ts';
import { getSettings, saveSettings } from '../src/server/settings.ts';
import {
  screeningRequest,
  screeningSchema,
  screeningBatchReady,
  screenPendingArticles,
  type ScreeningArticle,
} from '../src/server/article-screening.ts';
import { briefTokenUsage } from '../src/server/brief-token-usage.ts';
import { taskOverview, taskDetail } from '../src/server/admin-tasks.ts';
import {
  requestGeneration,
  dispatchGenerationRequests,
} from '../src/server/generation-requests.ts';
import { requestReprocessing, dispatchReprocessingBatches } from '../src/server/reprocessing.ts';
import type { PgBoss } from 'pg-boss';

if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('初筛测试必须连接独立_test数据库');
let boss: PgBoss;
let requests = 0;
const originalFetch = globalThis.fetch;
const connection = {
  enabled: true,
  baseUrl: 'https://screen.invalid/v1',
  apiKey: 'test-only',
  model: 'screen-test',
};
before(async () => {
  await migrate();
  boss = await getQueue();
});
beforeEach(async () => {
  for (const name of ['process', 'generate', 'collect', 'deliver']) await boss.deleteAllJobs(name);
  await pool.query(
    'TRUNCATE articles,model_calls,processing_steps,brief_requests,reprocessing_batches CASCADE',
  );
  await saveSettings({
    ...defaultSettings,
    modelOffPeakOnly: false,
    modelDailyLimit: 10000,
    modelConnection: connection,
  });
  requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    return reply({
      results: input.articles.map((a: { id: string; title: string }) => ({
        id: a.id,
        decision: a.title.startsWith('无关')
          ? 'BLOCK'
          : a.title.startsWith('不确定')
            ? 'UNCERTAIN'
            : 'PASS',
        reason: '根据实际材料判断',
      })),
    });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
after(async () => {
  await boss.stop();
  await pool.end();
});
function reply(value: unknown) {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }),
  );
}
async function add(title = 'AI模型升级', created = '2026-10-21T09:00:00Z') {
  return (
    await pool.query(
      `INSERT INTO articles(title,url,excerpt,published_at,source_name,industry_id,created_at)
     VALUES($1,$2,'真实来源正文，包含AI应用事实','2026-10-21T09:00:00Z','测试','ai',$3) RETURNING id`,
      [title, `https://example.invalid/${randomUUID()}`, created],
    )
  ).rows[0].id as string;
}

test('短材料按Unicode字符截取，规则共享，返回结果必须完整且唯一', () => {
  const a: ScreeningArticle = {
    id: randomUUID(),
    title: 'AI升级',
    excerpt: '😀'.repeat(400),
    source_name: '测试',
    sections: [],
    created_at: new Date('2026-11-13T07:59:40+08:00'),
    published_at: new Date('2026-11-13T07:59:40+08:00'),
  };
  const b = { ...a, id: randomUUID() };
  const request = screeningRequest([a, b], defaultSettings);
  assert.equal(Array.from(request.articles[0].excerpt).length, 300);
  assert.equal(Object.keys(request.sectionGroups).length, 1);
  const row = { id: a.id, decision: 'PASS', reason: '相关' };
  const schema = screeningSchema([a.id, b.id]);
  assert.equal(schema.safeParse({ results: [row] }).success, false);
  assert.equal(schema.safeParse({ results: [row, row] }).success, false);
  assert.equal(schema.safeParse({ results: [row, { ...row, id: randomUUID() }] }).success, false);
  assert.equal(schema.safeParse({ results: [row, { ...row, id: b.id }] }).success, true);
  assert.equal(
    screeningBatchReady([a], defaultSettings, new Date('2026-11-13T07:59:59+08:00')),
    false,
  );
  assert.equal(
    screeningBatchReady([a], defaultSettings, new Date('2026-11-13T08:00:00+08:00')),
    true,
  );
  assert.equal(
    screeningBatchReady([a], defaultSettings, new Date('2026-11-13T08:00:10+08:00')),
    true,
  );
  assert.equal(
    screeningBatchReady(
      Array.from({ length: 20 }, () => a),
      defaultSettings,
      a.created_at,
    ),
    true,
  );
  assert.equal(screeningBatchReady([a], defaultSettings, a.created_at, true), true);
});

test('BLOCK终结，PASS与UNCERTAIN进入原队列，任务详情和刊期统计保留初筛且不重复付费', async () => {
  const pass = await add();
  const block = await add('无关金融行情');
  const uncertain = await add('不确定的AI线索');
  await enqueuePendingArticles();
  assert.equal(requests, 1);
  const rows = await pool.query('SELECT id,state FROM articles');
  assert.equal(rows.rows.find((a) => a.id === block).state, 'ignored');
  const queued = await pool.query(
    "SELECT id job_id,data->>'id' id FROM pgboss.job WHERE name='process' AND state='created'",
  );
  assert.deepEqual(new Set(queued.rows.map((a) => a.id)), new Set([pass, uncertain]));
  assert.equal((await pool.query('SELECT 1 FROM article_screenings')).rowCount, 3);
  await enqueuePendingArticles();
  assert.equal(requests, 1);
  const overview = await taskOverview('无关金融行情');
  assert.equal(overview[0].state, 'succeeded');
  const detail = await taskDetail(`article:${block}`);
  assert.equal(detail!.steps[0].stage, 'screening');
  assert.equal((detail!.steps[0].result as { decision: string }).decision, 'BLOCK');
  assert.ok(detail!.steps[0].input_tokens! <= 4);
  const passedDetail = await taskDetail(`job:${queued.rows.find((r) => r.id === pass).job_id}`);
  assert.ok(passedDetail!.attemptsForArticle[0].steps.some((step) => step.stage === 'screening'));
  assert.deepEqual(await briefTokenUsage('2026-10-22', null, '08:00'), {
    current: 18,
    previous: null,
  });
});

test('每批不超过20篇，余量继续初筛，不重发前批也不漏排通过项', async () => {
  for (let i = 0; i < 25; i++) await add();
  await enqueuePendingArticles();
  assert.equal(requests, 1);
  assert.equal((await pool.query('SELECT 1 FROM article_screenings')).rowCount, 20);
  await enqueuePendingArticles();
  assert.equal(requests, 2);
  assert.equal((await pool.query('SELECT 1 FROM article_screenings')).rowCount, 25);
  assert.equal(
    (await pool.query("SELECT 1 FROM pgboss.job WHERE name='process' AND state='created'"))
      .rowCount,
    25,
  );
});

test('初筛失败后额度耗尽时也保留已用token，恢复后不重复或漏算旧批费用', async () => {
  await add();
  await add();
  const config = await getSettings();
  await saveSettings({ ...config, modelDailyLimit: 1 });
  globalThis.fetch = async () => {
    requests++;
    return reply({ results: [] });
  };
  await screenPendingArticles();
  assert.equal(requests, 2);
  assert.equal((await pool.query('SELECT 1 FROM article_screenings')).rowCount, 0);
  assert.deepEqual(await briefTokenUsage('2026-10-22', null, '08:00'), {
    current: 36,
    previous: null,
  });
  await saveSettings(config);
  globalThis.fetch = async (_url, init) => {
    requests++;
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    return reply({
      results: input.articles.map((a: { id: string }) => ({
        id: a.id,
        decision: 'PASS',
        reason: '继续分析',
      })),
    });
  };
  await screenPendingArticles();
  assert.equal(requests, 3);
  assert.deepEqual(await briefTokenUsage('2026-10-22', null, '08:00'), {
    current: 54,
    previous: null,
  });
});

test('小批等待30秒，截稿和等待出刊请求会提前冲刷；初筛中不会提前出刊', async () => {
  const now = new Date('2026-10-21T06:00:00Z');
  const id = await add('AI模型升级', new Date(now.getTime() - 29_000).toISOString());
  // published_at is before this artificial now's cutoff; move it into the current cycle.
  await pool.query('UPDATE articles SET published_at=$2 WHERE id=$1', [id, now]);
  assert.deepEqual(await screenPendingArticles(now), []);
  assert.equal(requests, 0);
  await screenPendingArticles(new Date(now.getTime() + 1000));
  assert.equal(requests, 1);
  const pending = await add('AI金融工具');
  await requestGeneration('daily', '2026-10-22', { force: true });
  assert.equal(
    (await pool.query("SELECT 1 FROM pgboss.job WHERE name='generate' AND state='created'"))
      .rowCount,
    0,
  );
  assert.equal(
    (await pool.query('SELECT state FROM articles WHERE id=$1', [pending])).rows[0].state,
    'pending',
  );
  await enqueuePendingArticles();
  assert.equal(
    (
      await pool.query("SELECT 1 FROM pgboss.job WHERE name='process' AND data->>'id'=$1", [
        pending,
      ])
    ).rowCount,
    1,
  );
  await dispatchGenerationRequests();
  assert.equal(
    (await pool.query("SELECT 1 FROM pgboss.job WHERE name='generate' AND state='created'"))
      .rowCount,
    0,
  );
});

test('初筛失败重试一次后按不确定兜底；失败请求消耗仍按成员计入', async () => {
  await add();
  await add();
  globalThis.fetch = async () => {
    requests++;
    return new Response('unavailable', { status: 503 });
  };
  await enqueuePendingArticles();
  assert.equal(requests, 2);
  assert.equal((await pool.query("SELECT 1 FROM articles WHERE state='pending'")).rowCount, 2);
  assert.equal(
    (await pool.query("SELECT 1 FROM article_screenings WHERE fallback AND decision='UNCERTAIN'"))
      .rowCount,
    2,
  );
  assert.equal(
    (await pool.query("SELECT 1 FROM pgboss.job WHERE name='process' AND state='created'"))
      .rowCount,
    2,
  );
});

test('ID不完整经过修复仍失败时整批兜底，不能静默丢掉遗漏项', async () => {
  await add();
  await add();
  globalThis.fetch = async () => {
    requests++;
    return reply({ results: [] });
  };
  await screenPendingArticles();
  assert.equal(requests, 4);
  assert.equal((await pool.query('SELECT 1 FROM article_screenings WHERE fallback')).rowCount, 2);
  assert.deepEqual(await briefTokenUsage('2026-10-22', null, '08:00'), {
    current: 72,
    previous: null,
  });
});

test('额度用尽保持待初筛，关闭模型不发送请求，不用异常兜底绕过额度', async () => {
  await add();
  const settings = await getSettings();
  await saveSettings({ ...settings, modelDailyLimit: 1 });
  await pool.query("INSERT INTO model_calls(purpose,state) VALUES('article','succeeded')");
  assert.deepEqual(await screenPendingArticles(), []);
  assert.equal(requests, 0);
  assert.equal((await pool.query('SELECT 1 FROM article_screenings')).rowCount, 0);
  await saveSettings({ ...settings, modelConnection: { ...connection, enabled: false } });
  assert.deepEqual(await screenPendingArticles(), []);
  assert.equal(requests, 0);
});

test('两个调度器竞争同批只发送一次；改材料或规则后重新初筛，旧判断不淘汰新材料', async () => {
  const id = await add('无关金融行情');
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async (_url, init) => {
    requests++;
    entered();
    await gate;
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    return reply({
      results: input.articles.map((a: { id: string }) => ({
        id: a.id,
        decision: 'BLOCK',
        reason: '明确无关',
      })),
    });
  };
  const first = screenPendingArticles();
  await started;
  assert.deepEqual(await screenPendingArticles(), []);
  assert.equal(requests, 1);
  await pool.query("UPDATE articles SET excerpt='新补充：银行发布AI风控模型' WHERE id=$1", [id]);
  release();
  await first;
  assert.equal(
    (await pool.query('SELECT state FROM articles WHERE id=$1', [id])).rows[0].state,
    'pending',
  );
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM processing_steps WHERE subject=$1 AND stage='screening'",
        [`article:${id}`],
      )
    ).rows[0].state,
    'skipped',
  );
  globalThis.fetch = async () => {
    requests++;
    return reply({ results: [{ id, decision: 'PASS', reason: '有AI事实' }] });
  };
  await screenPendingArticles();
  assert.equal(requests, 2);
  await saveSettings({
    ...(await getSettings()),
    editorialPrompt: '只关注有具体事实的AI应用和治理',
  });
  await screenPendingArticles();
  assert.equal(requests, 3);
});

test('模型成功但落库中断，重启调度复用已付费结果', async () => {
  await add();
  await pool.query(
    "CREATE FUNCTION screening_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated interrupted save'; END $$",
  );
  try {
    await pool.query(
      'CREATE TRIGGER screening_test_failure BEFORE INSERT ON article_screenings FOR EACH ROW EXECUTE FUNCTION screening_test_failure()',
    );
    await assert.rejects(screenPendingArticles(), /simulated interrupted save/);
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS screening_test_failure ON article_screenings');
    await pool.query('DROP FUNCTION screening_test_failure()');
  }
  assert.equal(requests, 1);
  await screenPendingArticles();
  assert.equal(requests, 1);
  assert.equal((await pool.query('SELECT 1 FROM article_screenings')).rowCount, 1);
  assert.equal((await pool.query('SELECT reused_count FROM model_calls')).rows[0].reused_count, 1);
});

test('跨刊期批次整数分摊不重算不漏算；已淘汰资讯仍可手动重处理', async () => {
  const old = await add('无关旧资讯', '2026-10-20T09:00:00Z');
  const current = await add('无关新资讯', '2026-10-21T09:00:00Z');
  await screenPendingArticles();
  const usage = await briefTokenUsage('2026-10-22', '2026-10-21', '08:00');
  assert.equal(usage.current + usage.previous!, 18);
  assert.equal(usage.current, 8);
  assert.equal(usage.previous, 10);
  await requestReprocessing({
    from: '2026-10-20T00:00:00Z',
    to: '2026-10-22T00:00:00Z',
    scope: 'all',
  });
  await dispatchReprocessingBatches();
  const jobs = await pool.query(
    "SELECT data->>'id' id FROM pgboss.job WHERE name='process' AND state='created'",
  );
  assert.deepEqual(new Set(jobs.rows.map((j) => j.id)), new Set([old, current]));
  await enqueuePendingArticles();
  assert.equal(requests, 1);
});
