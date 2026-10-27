import { z } from 'zod';
import { pool } from './db.ts';
import { enqueue } from './queue.ts';
import { getSettings } from './settings.ts';
import { PROCESS_VERSION } from './process.ts';
import { rangeFor, validDate } from './periods.ts';

const requestSchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  scope: z.enum(['outdated', 'all']).default('outdated'),
  regenerateDate: z.string().refine(validDate).optional(),
});
export async function requestReprocessing(input: unknown) {
  const value = requestSchema.parse(input);
  const start = new Date(value.from),
    end = new Date(value.to);
  if (end <= start || end.getTime() - start.getTime() > 31 * 86400000)
    throw new Error('重新处理范围须在31天以内，结束时间应晚于开始时间');
  if (end.getTime() > Date.now() + 60000) throw new Error('结束时间不能晚于当前时间');
  if (value.regenerateDate) {
    const range = rangeFor('daily', value.regenerateDate, '08:00');
    if (range.start < start || range.end > end)
      throw new Error('时间范围必须完整覆盖需要更新的日报，且该日报已经截稿');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(76140510)');
    const candidates = await client.query(
      `SELECT * FROM articles WHERE published_at >= $1 AND published_at < $2
      AND ($3='all' OR processing_version IS DISTINCT FROM $4 OR state='failed') ORDER BY published_at,id LIMIT 501`,
      [start, end, value.scope, PROCESS_VERSION],
    );
    if (!candidates.rows.length) throw new Error('所选范围没有需要重新处理的资讯');
    if (candidates.rows.length > 500) throw new Error('单批最多500条，请缩短时间范围');
    const ids = candidates.rows.map((r) => r.id);
    const overlapping = await client.query(
      `SELECT 1 FROM reprocessing_items i JOIN reprocessing_batches b ON b.id=i.batch_id
      WHERE i.article_id=ANY($1::uuid[]) AND b.state IN ('waiting','processing','generating') LIMIT 1`,
      [ids],
    );
    if (overlapping.rows.length)
      throw new Error('所选资讯已有未完成的重新处理批次，请在批次记录中查看进度');
    const {
      rows: [batch],
    } = await client.query(
      `INSERT INTO reprocessing_batches(range_start,range_end,scope,total,regenerate_date)
      VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [start, end, value.scope, ids.length, value.regenerateDate ?? null],
    );
    await client.query(
      `INSERT INTO reprocessing_items(batch_id,article_id,article_snapshot)
      SELECT $1,id,to_jsonb(a) FROM articles a WHERE id=ANY($2::uuid[])`,
      [batch.id, ids],
    );
    await client.query('COMMIT');
    return { id: batch.id as string, total: ids.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function dispatchReprocessingBatches() {
  const config = await getSettings();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(76140510)');
    await client.query(`UPDATE reprocessing_items i SET state=a.state,finished_at=now(),error=CASE WHEN a.state='failed' THEN
      coalesce((SELECT s.error FROM processing_steps s WHERE s.subject='article:'||a.id::text AND s.state='failed' ORDER BY s.started_at DESC LIMIT 1),'处理失败') ELSE NULL END
      FROM articles a WHERE i.article_id=a.id AND i.state='queued' AND a.state IN ('processed','ignored','failed')`);
    await client.query(
      "UPDATE reprocessing_items SET state='failed',error='原始资讯已被清理',finished_at=now() WHERE article_id IS NULL AND state IN ('waiting','queued')",
    );
    const budget = await client.query(`SELECT
      (SELECT count(*)::int FROM model_calls WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') used,
      (SELECT count(*)::int FROM pgboss.job WHERE name IN ('process','generate') AND state IN ('created','active','retry')) queued`);
    let slots = Math.max(
      0,
      Math.min(100, config.modelDailyLimit - budget.rows[0].used - budget.rows[0].queued - 1),
    );
    const pending =
      await client.query(`SELECT i.id,i.article_id,i.batch_id FROM reprocessing_items i
      JOIN reprocessing_batches b ON b.id=i.batch_id WHERE i.state='waiting' AND b.state IN ('waiting','processing')
      ORDER BY b.created_at,i.id LIMIT 500`);
    const queueDb = { executeSql: (sql: string, values?: unknown[]) => client.query(sql, values) };
    for (const item of pending.rows) {
      if (!slots) break;
      const active = await client.query(
        "SELECT 1 FROM pgboss.job WHERE name='process' AND data->>'id'=$1 AND state IN ('created','active','retry') LIMIT 1",
        [item.article_id],
      );
      if (active.rows.length) continue;
      await client.query("UPDATE articles SET state='pending' WHERE id=$1", [item.article_id]);
      const id = await enqueue(
        'process',
        { id: item.article_id, reprocessBatchId: item.batch_id, trigger: 'manual' },
        item.article_id,
        { priority: 100, db: queueDb },
      );
      if (!id) throw new Error('重新处理任务与已有任务冲突，系统稍后重试');
      await client.query("UPDATE reprocessing_items SET state='queued',job_id=$2 WHERE id=$1", [
        item.id,
        id,
      ]);
      await client.query("UPDATE reprocessing_batches SET state='processing' WHERE id=$1", [
        item.batch_id,
      ]);
      slots--;
    }
    const batches = await client.query(`SELECT b.*,b.regenerate_date::text date,
      count(*) FILTER(WHERE i.state IN ('waiting','queued'))::int unfinished,
      count(*) FILTER(WHERE i.state='failed')::int failed
      FROM reprocessing_batches b JOIN reprocessing_items i ON i.batch_id=b.id
      WHERE b.state IN ('waiting','processing','generating') GROUP BY b.id ORDER BY b.created_at`);
    for (const batch of batches.rows) {
      if (batch.unfinished) continue;
      if (batch.state === 'generating') {
        const {
          rows: [job],
        } = await client.query(
          `SELECT j.id,j.state,j.output,
          EXISTS(SELECT 1 FROM processing_steps s WHERE s.run_key='job:'||j.id::text AND s.stage='task' AND s.state='waiting') waiting
          FROM pgboss.job j WHERE name='generate' AND data->>'reprocessBatchId'=$1 ORDER BY created_on DESC LIMIT 1`,
          [batch.id],
        );
        if (!job || job.waiting || !['completed', 'failed', 'cancelled'].includes(job.state))
          continue;
        await client.query(
          'UPDATE reprocessing_batches SET state=$2,error=$3,finished_at=now(),generation_job_id=$4 WHERE id=$1',
          [
            batch.id,
            job.state === 'completed'
              ? batch.failed
                ? 'completed_with_errors'
                : 'completed'
              : 'failed',
            job.state === 'completed' ? null : (job.output?.message ?? '日报更新失败'),
            job.id,
          ],
        );
      } else if (batch.date) {
        const range = rangeFor('daily', batch.date, '08:00');
        const unfinished = await client.query(
          "SELECT 1 FROM articles WHERE state='pending' AND published_at >= $1 AND published_at < $2 LIMIT 1",
          [range.start, range.end],
        );
        if (unfinished.rows.length) continue;
        const id = await enqueue(
          'generate',
          {
            kind: 'daily',
            date: batch.date,
            backfill: true,
            publishWithoutMail: true,
            reprocessBatchId: batch.id,
            trigger: 'manual',
          },
          `daily:${batch.date}`,
          { priority: 100, db: queueDb },
        );
        if (id)
          await client.query(
            "UPDATE reprocessing_batches SET state='generating',generation_job_id=$2 WHERE id=$1",
            [batch.id, id],
          );
      } else {
        await client.query(
          'UPDATE reprocessing_batches SET state=$2,finished_at=now() WHERE id=$1',
          [batch.id, batch.failed ? 'completed_with_errors' : 'completed'],
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

type ReprocessingView = {
  id: string;
  range_start: Date;
  range_end: Date;
  state: string;
  total: number;
  waiting: number;
  queued: number;
  processed: number;
  ignored: number;
  failed: number;
  date: string | null;
  error: string | null;
  items: {
    batch_id: string;
    article_id: string | null;
    title: string;
    state: string;
    error: string | null;
  }[];
};
export async function reprocessingBatches(): Promise<ReprocessingView[]> {
  const { rows } = await pool.query(`SELECT b.*,b.regenerate_date::text date,
    count(*) FILTER(WHERE i.state='waiting')::int waiting,count(*) FILTER(WHERE i.state='queued')::int queued,
    count(*) FILTER(WHERE i.state='processed')::int processed,count(*) FILTER(WHERE i.state='ignored')::int ignored,
    count(*) FILTER(WHERE i.state='failed')::int failed
    FROM reprocessing_batches b JOIN reprocessing_items i ON i.batch_id=b.id GROUP BY b.id ORDER BY b.created_at DESC LIMIT 10`);
  const items = rows.length
    ? (
        await pool.query(
          `SELECT i.batch_id,i.state,i.error,i.article_snapshot->>'title' title,
    i.article_id FROM reprocessing_items i WHERE batch_id=ANY($1::uuid[]) ORDER BY i.id`,
          [rows.map((r) => r.id)],
        )
      ).rows
    : [];
  return rows.map((b) => ({ ...b, items: items.filter((i) => i.batch_id === b.id) }));
}
