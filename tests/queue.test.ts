import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getQueue, enqueue, enqueuePendingArticles } from '../src/server/queue.ts';
import { pool } from '../src/server/db.ts';
import { getSettings, saveSettings } from '../src/server/settings.ts';
import type { PgBoss } from 'pg-boss';
if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('队列测试必须连接独立 _test 库');
let boss: PgBoss;
before(async () => {
  boss = await getQueue();
  await boss.deleteAllJobs('generate');
});
after(async () => {
  await boss.stop();
  await pool.end();
});
test('同一简报在排队或执行中不重复入队，完成后允许重新生成', async () => {
  const key = randomUUID();
  const data = { kind: 'daily', date: '2026-10-22' };
  const id = await enqueue('generate', data, key);
  assert.ok(id);
  assert.equal(await enqueue('generate', data, key), null);
  const [job] = await boss.fetch('generate');
  assert.equal(job.id, id);
  assert.equal(await enqueue('generate', data, key), null);
  await boss.complete('generate', job.id);
  assert.ok(await enqueue('generate', data, key));
  await boss.deleteAllJobs('generate');
});

test('初始积压优先处理最新资讯，额度不足继续等待并保留一次出刊调用', async () => {
  await boss.deleteAllJobs('process');
  await pool.query('TRUNCATE articles,model_calls CASCADE');
  const rows =
    await pool.query(`INSERT INTO articles(title,url,excerpt,published_at,source_name,industry_id) VALUES
    ('旧材料','https://example.invalid/old-budget','摘要',now()-interval '2 days','本地测试','ai'),
    ('新材料','https://example.invalid/new-budget','摘要',now()-interval '1 hour','本地测试','ai') RETURNING id`);
  const oldSettings = await getSettings();
  await saveSettings({
    ...oldSettings,
    modelDailyLimit: 2,
    modelOffPeakOnly: false,
    dailyEnabled: false,
    weeklyEnabled: false,
    monthlyEnabled: false,
  });
  try {
    await enqueuePendingArticles();
    const queued = await pool.query(
      "SELECT id,data FROM pgboss.job WHERE name='process' AND state='created'",
    );
    assert.equal(queued.rows.length, 1);
    assert.equal(queued.rows[0].data.id, rows.rows[1].id);
    await enqueuePendingArticles();
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM pgboss.job WHERE name='process' AND state='created'",
        )
      ).rows[0].n,
      1,
    );
    await boss.cancel('process', queued.rows[0].id);
    await pool.query("INSERT INTO model_calls(purpose,state) VALUES('article','succeeded')");
    await enqueuePendingArticles();
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM pgboss.job WHERE name='process' AND state='created'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM articles WHERE state='pending'")).rows[0].n,
      2,
    );
  } finally {
    await saveSettings(oldSettings);
    await boss.deleteAllJobs('process');
  }
});

test('预算等待不作为失败，调高额度后恢复排队而不直接发送模型请求', async () => {
  const { executeTask, resumeBudgetWaiting } = await import('../src/server/queue.ts');
  const { BudgetWait } = await import('../src/server/processing-log.ts');
  const config = await getSettings();
  await boss.deleteAllJobs('generate');
  await saveSettings({ ...config, modelOffPeakOnly: false, modelDailyLimit: 1 });
  await pool.query('TRUNCATE model_calls,processing_steps CASCADE');
  const id = await enqueue('generate', { kind: 'daily', date: '2026-10-20' }, 'daily:2026-10-20');
  const [job] = await boss.fetch('generate');
  assert.equal(job.id, id);
  await executeTask('generate', job.id, { kind: 'daily', date: '2026-10-20' }, async () => {
    throw new BudgetWait('今日额度不足');
  });
  await boss.complete('generate', job.id);
  await resumeBudgetWaiting();
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM pgboss.job WHERE name='generate' AND state='created'",
      )
    ).rows[0].n,
    0,
    '预算未变时不反复创建等待任务',
  );
  await pool.query("INSERT INTO model_calls(purpose,state) VALUES('article','succeeded')");
  await resumeBudgetWaiting();
  assert.equal(
    (await pool.query("SELECT 1 FROM pgboss.job WHERE name='generate' AND state='created'"))
      .rowCount,
    0,
  );
  await saveSettings({ ...config, modelOffPeakOnly: false, modelDailyLimit: 5 });
  await resumeBudgetWaiting();
  assert.equal(
    (await pool.query("SELECT 1 FROM pgboss.job WHERE name='generate' AND state='created'"))
      .rowCount,
    1,
  );
  assert.equal((await pool.query('SELECT 1 FROM model_calls')).rowCount, 1);
  await saveSettings(config);
  await boss.deleteAllJobs('generate');
});

test('模型任务失败自动进入重试并可完成，不需要人工放行', async () => {
  await boss.deleteAllJobs('process');
  const id = await boss.send(
    'process',
    { id: randomUUID() },
    { retryLimit: 1, retryDelay: 0, retryBackoff: false },
  );
  const [first] = await boss.fetch('process');
  assert.equal(first.id, id);
  await boss.fail('process', id!, { message: '本地服务临时失败' });
  const [retry] = await boss.fetch('process');
  assert.equal(retry.id, id);
  await boss.complete('process', id!);
  const row = await pool.query('SELECT state,retry_count FROM pgboss.job WHERE id=$1', [id]);
  assert.equal(row.rows[0].state, 'completed');
  assert.equal(row.rows[0].retry_count, 1);
  await boss.deleteAllJobs('process');
});

test('模型任务在高峰等待且不重试，波谷自动恢复同一任务', async () => {
  const { executeTask, resumeBudgetWaiting } = await import('../src/server/queue.ts');
  const { modelWindowOpen } = await import('../src/server/periods.ts');
  const peak = new Date('2026-11-05T11:59:59+08:00');
  const offPeak = new Date('2026-11-05T12:00:00+08:00');
  assert.equal(modelWindowOpen(true, peak), false);
  assert.equal(modelWindowOpen(true, offPeak), true);
  assert.equal(modelWindowOpen(true, new Date('2026-11-05T14:00:00+08:00')), false);
  assert.equal(modelWindowOpen(true, new Date('2026-11-05T18:00:00+08:00')), true);
  assert.equal(modelWindowOpen(true, new Date('2026-11-07T10:00:00+08:00')), true);
  assert.equal(modelWindowOpen(false, peak), true);
  const config = await getSettings();
  await saveSettings({ ...config, modelOffPeakOnly: true });
  await boss.deleteAllJobs('generate');
  try {
    const data = { kind: 'daily', date: '2026-11-05' };
    await enqueue('generate', data, 'daily:2026-11-05');
    const [job] = await boss.fetch('generate');
    assert.deepEqual(
      await executeTask('generate', job.id, data, async () => assert.fail('不应调用模型'), peak),
      { waitingModelWindow: true },
    );
    await boss.complete('generate', job.id);
    await resumeBudgetWaiting(peak);
    assert.deepEqual(await boss.fetch('generate'), []);
    await resumeBudgetWaiting(offPeak);
    const [resumed] = await boss.fetch('generate');
    assert.deepEqual(resumed.data, data);
    assert.equal(
      await executeTask('generate', resumed.id, data, async () => 'done', offPeak),
      'done',
    );
  } finally {
    await boss.deleteAllJobs('generate');
    await saveSettings(config);
  }
});

test('采集和资讯处理遇到网络错误时，队列至少等待五分钟再重试', async () => {
  const { executeTask } = await import('../src/server/queue.ts');
  const offPeak = new Date('2026-11-05T12:00:00+08:00');
  for (const name of ['collect', 'process'] as const) {
    const target = randomUUID();
    const data = { id: target };
    const id = (await boss.send(name, data, { retryLimit: 1, retryDelay: 10, priority: 1000 }))!;
    try {
      const [job] = await boss.fetch(name);
      assert.equal(job.id, id);
      const cause = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      const failure = new AggregateError([new Error('详情读取失败', { cause })], '网络错误');
      await assert.rejects(
        executeTask(
          name,
          id,
          data,
          async () => {
            throw failure;
          },
          offPeak,
        ),
        /网络错误/,
      );
      await boss.fail(name, id);
      const [retry] = (
        await pool.query(
          "SELECT state, start_after >= now() + interval '299 seconds' AS delayed FROM pgboss.job WHERE id=$1",
          [id],
        )
      ).rows;
      assert.equal(retry.state, 'retry');
      assert.equal(retry.delayed, true);
    } finally {
      await boss.deleteJob(name, id);
    }
  }
});
