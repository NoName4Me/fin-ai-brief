import { editionRecordSchema } from './editorial.ts';
import { explainEditionRecord } from './edition-status.ts';
import { z } from 'zod';
import { pool } from './db.ts';
import { enqueue } from './queue.ts';
export async function batchDetail(id: string) {
  z.uuid().parse(id);
  const { rows } = await pool.query<{
    id: string;
    range_start: Date;
    range_end: Date;
    scope: string;
    state: string;
    total: number;
    date: string | null;
    error: string | null;
    created_at: Date;
    finished_at: Date | null;
    generation_job_id: string | null;
  }>('SELECT *,regenerate_date::text date FROM reprocessing_batches WHERE id=$1', [id]);
  const batch = rows[0];
  if (!batch) return null;
  const [items, generation, edition] = await Promise.all([
    pool.query<{
      id: string;
      article_id: string | null;
      title: string;
      url: string | null;
      state: string;
      error: string | null;
      job_id: string | null;
      finished_at: Date | null;
    }>(
      `SELECT i.id,i.article_id,coalesce(i.article_snapshot->>'title',a.title,'原资讯已清理') title,coalesce(a.url,i.article_snapshot->>'url') url,i.state,i.error,i.job_id,i.finished_at
      FROM reprocessing_items i LEFT JOIN articles a ON a.id=i.article_id WHERE i.batch_id=$1
      ORDER BY CASE i.state WHEN 'failed' THEN 0 WHEN 'queued' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,i.id`,
      [id],
    ),
    batch.generation_job_id
      ? pool.query<{
          id: string;
          state: string;
          error: string | null;
          brief_id: string | null;
          has_draft: boolean;
          is_published: boolean;
        }>(
          `SELECT j.id,CASE WHEN j.state='completed' AND EXISTS(SELECT 1 FROM processing_steps p WHERE p.run_key='job:'||j.id::text AND p.stage='task' AND p.state='waiting') THEN 'waiting_budget' ELSE j.state::text END state,
      CASE WHEN j.state IN ('failed','cancelled') THEN coalesce(j.output->>'message',j.output->'value'->>'message') ELSE NULL END error,
      b.id brief_id,b.draft IS NOT NULL has_draft,b.published IS NOT NULL is_published
      FROM pgboss.job j LEFT JOIN briefs b ON b.kind='daily' AND b.period_date=$2::date WHERE j.id=$1`,
          [batch.generation_job_id, batch.date],
        )
      : Promise.resolve({ rows: [] }),
    batch.generation_job_id
      ? pool.query(
          "SELECT result FROM processing_steps WHERE run_key='job:'||$1 AND stage='edition' ORDER BY finished_at DESC LIMIT 1",
          [batch.generation_job_id],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  const counts = { waiting: 0, queued: 0, processed: 0, ignored: 0, failed: 0 };
  for (const item of items.rows)
    if (Object.hasOwn(counts, item.state)) counts[item.state as keyof typeof counts]++;
  return {
    batch,
    items: items.rows,
    counts,
    generation: generation.rows[0] ?? null,
    edition: editionRecordSchema
      .array()
      .parse(edition.rows[0]?.result ?? [])
      .map((row) => explainEditionRecord(row, counts.failed)),
  };
}

export async function retryBatchFailures(id: string) {
  z.uuid().parse(id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(76140510)');
    const batch = (
      await client.query(
        'SELECT *,regenerate_date::text date FROM reprocessing_batches WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!batch) throw new Error('批次不存在');
    if (!['completed_with_errors', 'failed'].includes(batch.state))
      throw new Error('请等待批次结束后再重试失败项');
    const failed = await client.query(
      "SELECT article_id FROM reprocessing_items WHERE batch_id=$1 AND state='failed' AND article_id IS NOT NULL FOR UPDATE",
      [id],
    );
    if (failed.rows.length) {
      const ids = failed.rows.map((item) => item.article_id);
      const busy = await client.query(
        `SELECT 1 FROM reprocessing_items i JOIN reprocessing_batches b ON b.id=i.batch_id
        WHERE i.article_id=ANY($1::uuid[]) AND b.id<>$2 AND b.state IN ('waiting','processing','generating')
        UNION ALL SELECT 1 FROM pgboss.job WHERE name='process' AND data->>'id'=ANY($3::text[]) AND state IN ('created','active','retry') LIMIT 1`,
        [ids, id, ids],
      );
      if (busy.rows.length) throw new Error('部分资讯正在其他任务中处理，请稍后重试');
      await client.query(
        "UPDATE reprocessing_items SET state='waiting',job_id=NULL,error=NULL,finished_at=NULL WHERE batch_id=$1 AND state='failed' AND article_id IS NOT NULL",
        [id],
      );
      await client.query(
        "UPDATE reprocessing_batches SET state='waiting',error=NULL,finished_at=NULL,generation_job_id=NULL WHERE id=$1",
        [id],
      );
    } else if (batch.state === 'failed' && batch.date) {
      const active = await client.query(
        "SELECT 1 FROM pgboss.job WHERE name='generate' AND data->>'reprocessBatchId'=$1 AND state IN ('created','active','retry') LIMIT 1",
        [id],
      );
      if (active.rows.length) throw new Error('日报生成任务已在执行');
      const jobId = await enqueue(
        'generate',
        {
          kind: 'daily',
          date: batch.date,
          backfill: true,
          publishWithoutMail: true,
          reprocessBatchId: id,
          trigger: 'manual',
        },
        `daily:${batch.date}`,
        { priority: 100, db: { executeSql: (sql, values) => client.query(sql, values) } },
      );
      if (!jobId) throw new Error('该刊期已有生成任务，请稍后重试');
      await client.query(
        "UPDATE reprocessing_batches SET state='generating',generation_job_id=$2,error=NULL,finished_at=NULL WHERE id=$1",
        [id, jobId],
      );
    } else throw new Error('没有可重试的失败资讯，原始材料可能已被清理');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
