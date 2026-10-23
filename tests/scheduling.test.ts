import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pool } from '../src/server/db.ts';
import { migrate } from '../scripts/migrate.ts';
import { settingsSchema, defaultSettings } from '../src/server/types.ts';
import { saveSettings } from '../src/server/settings.ts';
import { getQueue, enqueue, executeTask, reconcileFailedArticles } from '../src/server/queue.ts';
import {
  requestGeneration,
  dispatchGenerationRequests,
} from '../src/server/generation-requests.ts';
import { processingController } from '../src/server/processing-worker.ts';
import { retryArticle } from '../src/server/admin-tasks.ts';
import type { PgBoss } from 'pg-boss';
if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('调度测试必须连接独立 _test 库');
let boss: PgBoss;
before(async () => {
  await migrate();
  boss = await getQueue();
});
beforeEach(async () => {
  for (const name of ['process', 'generate', 'collect', 'deliver']) await boss.deleteAllJobs(name);
  await pool.query('TRUNCATE articles,brief_requests,processing_steps,model_calls CASCADE');
  await saveSettings(defaultSettings);
});
after(async () => {
  await boss.stop();
  await pool.end();
});
async function article(date = '2026-10-21T12:00:00Z') {
  return (
    await pool.query(
      `INSERT INTO articles(title,url,excerpt,published_at,source_name,industry_id)
    VALUES('本地调度测试',$1,'摘要',$2,'测试','ai') RETURNING id`,
      [`https://example.invalid/${randomUUID()}`, date],
    )
  ).rows[0].id as string;
}
async function until(check: () => Promise<boolean>, timeout = 5000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error('等待调度状态超时');
    await delay(20);
  }
}

test('配置默认重试1次、并发3篇，拒绝超过3次重试或20个并发', () => {
  assert.equal(settingsSchema.parse(defaultSettings).taskRetryLimit, 1);
  assert.equal(settingsSchema.parse(defaultSettings).processingConcurrency, 3);
  for (const value of [-1, 4, 1.5])
    assert.throws(() => settingsSchema.parse({ ...defaultSettings, taskRetryLimit: value }));
  for (const value of [0, 21, 1.5])
    assert.throws(() => settingsSchema.parse({ ...defaultSettings, processingConcurrency: value }));
});

test('配置的重试次数写入任务，耗尽后失败不再阻塞，并支持手动重开', async () => {
  for (const limit of [0, 1, 3]) {
    await saveSettings({ ...defaultSettings, taskRetryLimit: limit });
    const id = await article();
    const jobId = await enqueue('process', { id }, id);
    assert.equal(
      (await pool.query('SELECT retry_limit FROM pgboss.job WHERE id=$1', [jobId])).rows[0]
        .retry_limit,
      limit,
    );
    await pool.query('UPDATE pgboss.job SET retry_delay=0,retry_backoff=false WHERE id=$1', [
      jobId,
    ]);
    for (let attempt = 0; attempt <= limit; attempt++) {
      const [job] = await boss.fetch('process');
      assert.equal(job.id, jobId);
      await assert.rejects(
        executeTask('process', job.id, { id }, async () => {
          throw new Error('测试失败');
        }),
      );
      assert.equal(
        (await pool.query('SELECT state FROM articles WHERE id=$1', [id])).rows[0].state,
        attempt < limit ? 'pending' : 'failed',
      );
      await boss.fail('process', job.id, { message: '测试失败' });
    }
    assert.equal(
      (await pool.query('SELECT state FROM pgboss.job WHERE id=$1', [jobId])).rows[0].state,
      'failed',
    );
    await dispatchGenerationRequests();
  }
  const failed = (await pool.query("SELECT id FROM articles WHERE state='failed' LIMIT 1")).rows[0]
    .id;
  assert.ok(await retryArticle(failed));
  assert.equal(
    (await pool.query('SELECT state FROM articles WHERE id=$1', [failed])).rows[0].state,
    'pending',
  );
});

test('强制生成只提升本期资讯优先级，不重复入队，依赖终结后优先出刊', async () => {
  const inside = await article();
  const outside = await article('2026-10-23T12:00:00Z');
  await enqueue('process', { id: outside }, outside);
  await enqueue('process', { id: inside }, inside);
  await assert.rejects(requestGeneration('daily', '2026-10-22'), /确认强制生成/);
  const requestId = await requestGeneration('daily', '2026-10-22', { force: true });
  await assert.rejects(requestGeneration('daily', '2026-10-22', { force: true }), /已有生成请求/);
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM pgboss.job WHERE name='process'")).rows[0].n,
    2,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM pgboss.job WHERE name='generate'")).rows[0].n,
    0,
  );
  const [first] = await boss.fetch<{ id: string }>('process');
  assert.equal(first.data.id, inside);
  await pool.query("UPDATE articles SET state='processed' WHERE id=$1", [inside]);
  await boss.complete('process', first.id);
  await dispatchGenerationRequests();
  const [generation] = await boss.fetch<{ requestId: string; kind: string; date: string }>(
    'generate',
  );
  assert.equal(generation.data.requestId, requestId);
  assert.equal(generation.data.date, '2026-10-22');
  assert.equal(
    (await pool.query('SELECT priority FROM pgboss.job WHERE id=$1', [generation.id])).rows[0]
      .priority,
    100,
  );
  await boss.complete('generate', generation.id);
  await dispatchGenerationRequests();
  assert.equal(
    (await pool.query('SELECT state FROM brief_requests WHERE id=$1', [requestId])).rows[0].state,
    'completed',
  );
});

test('Worker中断遗留的终态失败会被归档，强制生成继续进行', async () => {
  const id = await article();
  const jobId = await boss.send('process', { id }, { retryLimit: 0 });
  await boss.fetch('process');
  await boss.fail('process', jobId!, { message: '过期失败' });
  await reconcileFailedArticles();
  assert.equal(
    (await pool.query('SELECT state FROM articles WHERE id=$1', [id])).rows[0].state,
    'failed',
  );
  await requestGeneration('daily', '2026-10-22', { force: true });
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM pgboss.job WHERE name='generate' AND state='created'",
      )
    ).rows[0].n,
    1,
  );
});

test('实际Worker同时处理3篇且不超过配置，运行时可调整为1篇及20篇', async () => {
  let active = 0,
    maximum = 0,
    started = 0;
  let release!: () => void;
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const configure = processingController(boss, async () => {
    active++;
    started++;
    maximum = Math.max(maximum, active);
    try {
      await gate;
    } finally {
      active--;
    }
  });
  await configure();
  try {
    for (let n = 0; n < 6; n++) {
      const id = randomUUID();
      await enqueue('process', { id }, id);
    }
    await until(async () => started === 3);
    await delay(100);
    assert.equal(active, 3);
    assert.equal(maximum, 3);
    assert.equal(started, 3);
    release();
    await until(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM pgboss.job WHERE name='process' AND state='completed'",
          )
        ).rows[0].n === 6,
    );
    await saveSettings({ ...defaultSettings, processingConcurrency: 1 });
    await configure();
    started = 0;
    maximum = 0;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (let n = 0; n < 2; n++) {
      const id = randomUUID();
      await enqueue('process', { id }, id);
    }
    await until(async () => started === 1);
    await delay(100);
    assert.equal(active, 1);
    assert.equal(maximum, 1);
    assert.equal(started, 1);
    release();
    await until(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM pgboss.job WHERE name='process' AND state='completed'",
          )
        ).rows[0].n === 8,
    );
    await saveSettings({ ...defaultSettings, processingConcurrency: 20 });
    await configure();
    started = 0;
    maximum = 0;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (let n = 0; n < 25; n++) {
      const id = randomUUID();
      await enqueue('process', { id }, id);
    }
    await until(async () => started === 20);
    await delay(100);
    assert.equal(active, 20);
    assert.equal(maximum, 20);
    assert.equal(started, 20);
  } finally {
    release();
    await boss.offWork('process', { wait: true });
  }
});

test('强制出刊等待额度时不反复入队，恢复后保留优先级', async () => {
  const { BudgetWait } = await import('../src/server/processing-log.ts');
  const { resumeBudgetWaiting } = await import('../src/server/queue.ts');
  await saveSettings({ ...defaultSettings, modelDailyLimit: 1 });
  const id = await article();
  await enqueue('process', { id }, id);
  const [job] = await boss.fetch('process');
  await executeTask('process', job.id, { id }, async () => {
    throw new BudgetWait('等待额度');
  });
  await boss.complete('process', job.id);
  await requestGeneration('daily', '2026-10-22', { force: true });
  await dispatchGenerationRequests();
  await dispatchGenerationRequests();
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM pgboss.job WHERE name='process'")).rows[0].n,
    1,
  );
  await saveSettings({ ...defaultSettings, modelDailyLimit: 3 });
  await resumeBudgetWaiting();
  const [retry] = await boss.fetch<{ id: string }>('process');
  assert.equal(retry.data.id, id);
  assert.equal(
    (await pool.query('SELECT priority FROM pgboss.job WHERE id=$1', [retry.id])).rows[0].priority,
    100,
  );
});

test('出刊入队后新到的资讯返回依赖等待，不消耗生成重试', async () => {
  const { runGeneration } = await import('../src/server/generation-requests.ts');
  const requestId = await requestGeneration('daily', '2026-10-22', { force: true });
  const [job] =
    await boss.fetch<import('../src/server/generation-requests.ts').GenerationTask>('generate');
  const id = await article();
  assert.deepEqual(
    await executeTask('generate', job.id, { ...job.data }, () => runGeneration(job.id, job.data)),
    { waitingArticles: true },
  );
  await boss.complete('generate', job.id);
  await dispatchGenerationRequests();
  assert.equal(
    (await pool.query('SELECT state FROM brief_requests WHERE id=$1', [requestId])).rows[0].state,
    'waiting',
  );
  assert.equal(
    (await pool.query('SELECT retry_count FROM pgboss.job WHERE id=$1', [job.id])).rows[0]
      .retry_count,
    0,
  );
  const [dependency] = await boss.fetch<{ id: string }>('process');
  assert.equal(dependency.data.id, id);
});
