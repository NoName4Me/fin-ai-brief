import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db, pool } from './server/db.ts';
import {
  getQueue,
  enqueue,
  enqueuePendingArticles,
  executeTask,
  resumeBudgetWaiting,
  reconcileFailedArticles,
} from './server/queue.ts';
import { briefs, deliveries, sources } from './server/schema.ts';
import { collectSource } from './server/collect.ts';
import { processingController } from './server/processing-worker.ts';
import { deliver } from './server/mail.ts';
import { getSettings } from './server/settings.ts';
import { duePeriods, rangeFor } from './server/periods.ts';
import {
  dispatchGenerationRequests,
  runGeneration,
  type GenerationTask,
} from './server/generation-requests.ts';
const boss = await getQueue();
await boss.work<{ id: string; manual?: boolean }>('collect', async ([job]) =>
  executeTask('collect', job.id, job.data, () =>
    collectSource(job.data.id, undefined, undefined, { manual: job.data.manual }),
  ),
);
const configureProcessing = processingController(boss);
await configureProcessing();
await boss.work<GenerationTask>('generate', async ([job]) =>
  executeTask('generate', job.id, { ...job.data }, () => runGeneration(job.id, job.data)),
);
await boss.work<{ id: string }>('deliver', async (jobs) => {
  for (const job of jobs) await deliver(job.data.id);
});
async function tick() {
  let collecting = false;
  const config = await getSettings();
  if (config.collectionEnabled) {
    const due = await db
      .select()
      .from(sources)
      .where(
        and(
          eq(sources.enabled, true),
          or(isNull(sources.nextFetchAt), lt(sources.nextFetchAt, new Date())),
        ),
      );
    collecting = due.length > 0;
    for (const source of due) await enqueue('collect', { id: source.id }, source.id);
  }
  // 模型任务失败后由队列自动重试；达到每日次数上限则等待额度恢复。
  if (process.env.MODEL_CALLS_ENABLED === 'true') {
    await reconcileFailedArticles();
    await dispatchGenerationRequests();
    await resumeBudgetWaiting();
    await enqueuePendingArticles();
    const activeCollection = await pool.query(
      "SELECT 1 FROM pgboss.job WHERE name='collect' AND state IN ('created','active','retry') LIMIT 1",
    );
    for (const period of duePeriods(new Date(), config)) {
      if (collecting || activeCollection.rows.length) continue;
      const range = rangeFor(
        period.kind,
        period.date,
        config[
          period.kind === 'daily'
            ? 'dailyTime'
            : period.kind === 'weekly'
              ? 'weeklyTime'
              : 'monthlyTime'
        ],
        config,
      );
      const unfinished = await pool.query(
        "SELECT 1 FROM articles WHERE state='pending' AND published_at >= $1 AND published_at < $2 LIMIT 1",
        [range.start, range.end],
      );
      if (unfinished.rows.length) continue;
      if (!config[`${period.kind}Enabled`]) continue;
      const existing = await db
        .select()
        .from(briefs)
        .where(and(eq(briefs.kind, period.kind), eq(briefs.periodDate, period.date)));
      if (existing.length) continue;
      const attempted = await pool.query(
        "SELECT 1 FROM pgboss.job WHERE name='generate' AND data->>'kind'=$1 AND data->>'date'=$2 UNION ALL SELECT 1 FROM brief_requests WHERE kind=$1 AND period_date=$2::date AND state IN ('waiting','queued') LIMIT 1",
        [period.kind, period.date],
      );
      if (!attempted.rows.length)
        await enqueue('generate', period, `${period.kind}:${period.date}`);
    }
  }
  if (process.env.MAIL_ENABLED === 'true') {
    const pending = await db
      .select()
      .from(deliveries)
      .where(eq(deliveries.state, 'pending'))
      .limit(100);
    for (const delivery of pending) await enqueue('deliver', { id: delivery.id }, delivery.id);
  }
}
await boss.work('tick', async () => tick());
await boss.schedule('tick', '* * * * *');
await tick();
let dispatching = false;
const dispatcher = setInterval(() => {
  void configureProcessing().catch((error) => console.error('处理配置:', error.message));
  if (dispatching || process.env.MODEL_CALLS_ENABLED !== 'true') return;
  dispatching = true;
  void reconcileFailedArticles()
    .then(() => dispatchGenerationRequests())
    .catch((error) => console.error('出刊调度:', error.message))
    .finally(() => {
      dispatching = false;
    });
}, 5000);
console.log('Fin&AI简报 Worker 已启动；采集、模型与发信遵循本地开关。');
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(dispatcher);
  await boss.stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
