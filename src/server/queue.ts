import { duePeriods } from './periods.ts';
import { modelUsage } from './model.ts';
import { BudgetWait, stage, fingerprint } from './processing-log.ts';
import { PgBoss, type SendOptions } from 'pg-boss';
import { pool } from './db.ts';
import { getSettings } from './settings.ts';
const globalQueue = globalThis as typeof globalThis & { briefBoss?: Promise<PgBoss> };
export async function getQueue() {
  return (globalQueue.briefBoss ??= (async () => {
    if (!process.env.DATABASE_URL) throw new Error('未配置 DATABASE_URL');
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, max: 3 });
    boss.on('error', (error) => console.error('Queue:', error.message));
    await boss.start();
    for (const name of ['collect', 'process', 'generate', 'deliver', 'tick']) {
      const retry = ['collect', 'process', 'generate'].includes(name)
        ? { retryLimit: 1, retryDelay: 10, retryBackoff: true }
        : { retryLimit: 0 };
      await boss.createQueue(name, {
        policy: 'exclusive',
        ...retry,
        expireInSeconds: 900,
        retentionSeconds: 30 * 86400,
      });
      await boss.updateQueue(name, retry);
    }
    return boss;
  })());
}
export async function enqueue(
  name: 'collect' | 'process' | 'generate' | 'deliver',
  data: object,
  key: string,
  options: Pick<SendOptions, 'priority' | 'db'> = {},
) {
  const boss = await getQueue();
  const config = await getSettings();
  let payload = data as Record<string, unknown>;
  if (name === 'collect' || name === 'process') {
    const table = name === 'collect' ? 'sources' : 'articles';
    const field = name === 'collect' ? 'name' : 'title';
    const snapshot = await pool.query(`SELECT ${field} AS label FROM ${table} WHERE id::text=$1`, [
      payload.id,
    ]);
    if (snapshot.rows.length)
      payload = {
        ...payload,
        [name === 'collect' ? 'sourceName' : 'articleTitle']: snapshot.rows[0].label,
      };
  }
  return boss.send(name, payload, {
    singletonKey: key,
    ...options,
    retryLimit: name === 'deliver' ? 0 : config.taskRetryLimit,
    retryDelay: 10,
    retryBackoff: true,
  });
}

export async function enqueuePendingArticles() {
  const config = await getSettings();
  const limit = config.modelDailyLimit;
  const reserve = Math.max(
    1,
    duePeriods(new Date(), config).filter((p) => config[`${p.kind}Enabled`]).length,
  );
  const budget = await pool.query(`SELECT
      (SELECT count(*)::int FROM model_calls WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') AS used,
      (SELECT count(*)::int FROM pgboss.job WHERE name IN ('process','generate') AND state IN ('created','active','retry')) AS queued`);
  // 为出刊保留一次调用；超额材料继续等待，不创建必然触发额度错误的任务。
  const slots = Math.max(
    0,
    Math.min(100, limit - budget.rows[0].used - budget.rows[0].queued - reserve),
  );
  const pending = await pool.query(
    "SELECT a.id FROM articles a WHERE state='pending' AND NOT EXISTS (SELECT 1 FROM pgboss.job j WHERE name='process' AND state <> 'cancelled' AND data->>'id'=a.id::text) ORDER BY published_at DESC, created_at LIMIT $1",
    [slots],
  );
  for (const article of pending.rows) await enqueue('process', { id: article.id }, article.id);
}

async function budgetKey() {
  const config = await getSettings();
  return fingerprint({
    day: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }),
    count: config.modelDailyLimit,
  });
}
export async function executeTask<T>(
  name: string,
  id: string,
  data: Record<string, unknown>,
  run: () => Promise<T>,
) {
  const subject =
    name === 'process'
      ? `article:${data.id}`
      : name === 'collect'
        ? `source:${data.id}`
        : name === 'generate'
          ? `brief:${data.kind}:${data.date}`
          : `delivery:${data.id}`;
  try {
    return await stage(subject, `job:${id}`, 'task', run);
  } catch (error) {
    if (error instanceof BudgetWait) {
      await pool.query("UPDATE processing_steps SET result=$2 WHERE run_key=$1 AND stage='task'", [
        `job:${id}`,
        JSON.stringify({ budgetKey: await budgetKey() }),
      ]);
      return { waitingBudget: true };
    }
    if (name === 'process') {
      const job = await pool.query('SELECT retry_count,retry_limit FROM pgboss.job WHERE id=$1', [
        id,
      ]);
      if (job.rows.length && job.rows[0].retry_count >= job.rows[0].retry_limit)
        await pool.query("UPDATE articles SET state='failed' WHERE id=$1 AND state='pending'", [
          data.id,
        ]);
    }
    throw error;
  }
}
export async function resumeBudgetWaiting() {
  const usage = await modelUsage();
  if (usage.remaining <= 0) return;
  const jobs = await pool.query(
    `SELECT j.id,j.name,j.data,j.priority,s.result->>'budgetKey' AS budget_key FROM pgboss.job j JOIN processing_steps s ON s.run_key='job:'||j.id::text AND s.stage='task' AND s.state='waiting'
    WHERE j.name IN ('process','generate') AND j.state='completed' ORDER BY j.priority DESC,j.created_on LIMIT $1`,
    [Math.min(usage.remaining, 50)],
  );
  const currentBudget = await budgetKey();
  for (const job of jobs.rows) {
    if (job.budget_key === currentBudget) continue;
    const key = job.name === 'process' ? job.data.id : `${job.data.kind}:${job.data.date}`;
    const id = await enqueue(job.name, job.data, key, { priority: job.priority });
    if (id && job.data.requestId)
      await pool.query("UPDATE brief_requests SET job_id=$2,state='queued' WHERE id=$1", [
        job.data.requestId,
        id,
      ]);
    if (id)
      await pool.query(
        "UPDATE processing_steps SET state='skipped',result=$2 WHERE run_key=$1 AND stage='task'",
        [`job:${job.id}`, JSON.stringify({ resumedAs: id })],
      );
  }
}

// Covers expiration, worker crashes and pre-upgrade failures as well as normal handler errors.
export async function reconcileFailedArticles() {
  await pool.query(`UPDATE articles a SET state='failed' WHERE a.state='pending'
    AND (SELECT j.state FROM pgboss.job j WHERE j.name='process' AND j.data->>'id'=a.id::text AND j.state<>'cancelled' ORDER BY j.created_on DESC LIMIT 1)='failed'
    AND NOT EXISTS(SELECT 1 FROM pgboss.job j WHERE j.name='process' AND j.data->>'id'=a.id::text AND j.state IN ('created','retry','active'))`);
}
