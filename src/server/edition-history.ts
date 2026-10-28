import { pool } from './db.ts';
export async function latestEditionTask(date: string) {
  const queue = await pool.query("SELECT to_regclass('pgboss.job') AS table_name");
  if (!queue.rows[0]?.table_name) return null;
  const { rows } = await pool.query<{
    id: string;
    batch_id: string | null;
    trigger: string | null;
    completed_on: Date | null;
    failed: number;
  }>(
    `SELECT j.id,j.data->>'reprocessBatchId' batch_id,j.data->>'trigger' trigger,j.completed_on,
    (SELECT count(*)::int FROM reprocessing_items i WHERE i.batch_id::text=j.data->>'reprocessBatchId' AND i.state='failed') failed
    FROM pgboss.job j JOIN processing_steps p ON p.run_key='job:'||j.id::text AND p.stage='edition'
    WHERE j.name='generate' AND j.data->>'date'=$1 AND jsonb_typeof(p.result)='array' AND jsonb_array_length(p.result)>0
    ORDER BY p.finished_at DESC,j.created_on DESC LIMIT 1`,
    [date],
  );
  const row = rows[0];
  return row
    ? {
        href: row.batch_id
          ? `/admin/articles?type=reprocess&q=${row.batch_id}&batch=${row.batch_id}`
          : `/admin/articles?type=generate&q=job:${row.id}`,
        label: row.batch_id ? '重处理后出刊' : row.trigger === 'manual' ? '手动出刊' : '自动出刊',
        at: row.completed_on,
        failed: row.failed,
      }
    : null;
}
