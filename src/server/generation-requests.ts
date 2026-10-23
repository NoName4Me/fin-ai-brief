import { generateBrief, PendingArticles } from './briefs.ts';
import { pool } from './db.ts';
import { getSettings } from './settings.ts';
import { rangeFor } from './periods.ts';
import type { Kind } from './types.ts';
import { enqueue, reconcileFailedArticles } from './queue.ts';

export async function generationStatus(kind: Kind, date: string) {
  const config = await getSettings();
  const range = rangeFor(kind, date, config[`${kind}Time`], config);
  if (range.end > new Date()) throw new Error('该期统计区间尚未结束');
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE state='pending')::int pending,
      count(*) FILTER (WHERE state='failed')::int failed FROM articles
      WHERE published_at >= $1 AND published_at < $2`,
    [range.start, range.end],
  );
  return { ...(rows[0] as { pending: number; failed: number }), range };
}

// Durable request: waiting for articles does not occupy the generation worker or consume retries.
export async function requestGeneration(
  kind: Kind,
  date: string,
  options: { force?: boolean; expectedKey?: string } = {},
) {
  await reconcileFailedArticles();
  const { pending, range } = await generationStatus(kind, date);
  if (pending && !options.force) throw new Error('本期仍有资讯待处理，请重新预览并确认强制生成');
  const { rows } = await pool.query(
    `INSERT INTO brief_requests(kind,period_date,range_start,range_end,force,expected_key)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
    [kind, date, range.start, range.end, options.force ?? false, options.expectedKey ?? null],
  );
  if (!rows.length) throw new Error('本期已有生成请求，请在资讯与任务中查看进度');
  await dispatchGenerationRequests();
  return rows[0].id as string;
}

export async function dispatchGenerationRequests() {
  const client = await pool.connect();
  try {
    // Several web processes and workers may dispatch together; keep promotion/id assignment atomic.
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(76140506)');
    await client.query(`UPDATE brief_requests r SET state=CASE WHEN j.state='failed' OR j.state='cancelled' THEN 'failed' ELSE 'completed' END,
      error=j.output->>'message',finished_at=now() FROM pgboss.job j
      WHERE r.job_id=j.id AND r.state='queued' AND j.state IN ('failed','cancelled','completed')
      AND NOT EXISTS(SELECT 1 FROM processing_steps s WHERE s.run_key='job:'||j.id::text AND s.stage='task' AND s.state='waiting')`);
    const requests = await client.query(
      "SELECT *,period_date::text date FROM brief_requests WHERE state='waiting' ORDER BY force DESC,created_at",
    );
    const db = { executeSql: (sql: string, values?: unknown[]) => client.query(sql, values) };
    for (const request of requests.rows) {
      const pending = await client.query(
        "SELECT id FROM articles WHERE state='pending' AND published_at >= $1 AND published_at < $2 ORDER BY published_at DESC",
        [request.range_start, request.range_end],
      );
      if (pending.rows.length) {
        for (const article of pending.rows) {
          const existing = await client.query(
            "SELECT id,state FROM pgboss.job WHERE name='process' AND data->>'id'=$1 AND state IN ('created','retry','active')",
            [article.id],
          );
          if (existing.rows.length) {
            await client.query(
              "UPDATE pgboss.job SET priority=100 WHERE name='process' AND id=$1 AND state IN ('created','retry')",
              [existing.rows[0].id],
            );
          } else {
            // An exhausted/legacy failure must remain visible and must not be requeued forever.
            const prior = await client.query(
              "SELECT 1 FROM pgboss.job WHERE name='process' AND data->>'id'=$1 AND state<>'cancelled' LIMIT 1",
              [article.id],
            );
            await client.query(
              `UPDATE pgboss.job j SET priority=100 WHERE j.name='process' AND j.data->>'id'=$1 AND j.state='completed'
              AND EXISTS(SELECT 1 FROM processing_steps s WHERE s.run_key='job:'||j.id::text AND s.stage='task' AND s.state='waiting')`,
              [article.id],
            );
            if (!prior.rows.length)
              await enqueue('process', { id: article.id }, article.id, { priority: 100, db });
          }
        }
        continue;
      }
      const data = {
        kind: request.kind,
        date: request.date,
        expectedKey: request.force ? undefined : (request.expected_key ?? undefined),
        requestId: request.id,
      };
      const id = await enqueue('generate', data, `${data.kind}:${data.date}`, {
        priority: request.force ? 100 : 50,
        db,
      });
      if (id)
        await client.query("UPDATE brief_requests SET state='queued',job_id=$2 WHERE id=$1", [
          request.id,
          id,
        ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface GenerationTask {
  kind: Kind;
  date: string;
  expectedKey?: string;
  requestId?: string;
}
export async function runGeneration(jobId: string, data: GenerationTask) {
  try {
    return await generateBrief(data.kind, data.date, data.expectedKey);
  } catch (error) {
    if (!(error instanceof PendingArticles) || !data.requestId) throw error;
    // Collection can add another article between dispatch and generation. Return to dependency
    // scheduling without consuming retries, and promote the newly arrived material too.
    await pool.query(
      "UPDATE brief_requests SET state='waiting',job_id=NULL WHERE id=$1 AND job_id=$2",
      [data.requestId, jobId],
    );
    return { waitingArticles: true };
  }
}
