import { pool } from './db.ts';
import { enqueue } from './queue.ts';
import { z } from 'zod';
import { editionRecordSchema, ratingRuleSchema, defaultRatingRules } from './editorial.ts';
export interface TaskStep {
  id: string;
  subject: string;
  run_key: string;
  stage: string;
  state: string;
  started_at: Date;
  finished_at: Date | null;
  result: unknown;
  error: string | null;
  call_id: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  input_summary: unknown;
  response: unknown;
}
export { stageNames, stateNames, taskTypes } from './task-labels.ts';
import { taskTypes } from './task-labels.ts';
export type TaskType = keyof typeof taskTypes;
export interface ManagedTask {
  id: string;
  queue: TaskType;
  name: string;
  target_id: string | null;
  job_id: string | null;
  request_id: string | null;
  created_on: Date;
  started_on: Date | null;
  completed_on: Date | null;
  state: string;
  retry_count: number;
  retry_limit: number;
  data: {
    id?: string;
    kind?: string;
    date?: string;
    manual?: boolean;
    trigger?: string;
    requestId?: string;
    expectedKey?: string;
    sourceName?: string;
    articleTitle?: string;
  };
  error: string | null;
}
const kindLabel = `CASE j.data->>'kind' WHEN 'daily' THEN '日报' WHEN 'weekly' THEN '周报' WHEN 'monthly' THEN '月报' ELSE '简报' END`;
// Filter the combined projection before limiting: source activity cannot hide an article search.
const taskProjection = `WITH unified AS (
  SELECT 'job:'||j.id::text id,j.name queue,
    CASE j.name WHEN 'collect' THEN coalesce(j.data->>'sourceName',s.name,'已删除信源（'||coalesce(j.data->>'id','未知')||'）')
    WHEN 'process' THEN coalesce(j.data->>'articleTitle',a.title,'已删除资讯')
    ELSE ${kindLabel}||' '||coalesce(j.data->>'date','')||'（'||CASE WHEN j.data->>'trigger'='manual' OR j.data->>'expectedKey' IS NOT NULL THEN '手动' ELSE '自动' END||'）' END name,
    j.data->>'id' target_id,j.id job_id,NULL::uuid request_id,j.created_on,j.started_on,j.completed_on,
    CASE WHEN j.state='completed' AND EXISTS(SELECT 1 FROM processing_steps p WHERE p.run_key='job:'||j.id::text AND p.stage='task' AND p.state='waiting') THEN 'waiting_budget'
      WHEN j.state='completed' THEN 'succeeded' ELSE j.state::text END state,
    j.retry_count,j.retry_limit,j.data,j.output->>'message' error
  FROM pgboss.job j LEFT JOIN sources s ON j.name='collect' AND s.id::text=j.data->>'id'
    LEFT JOIN articles a ON j.name='process' AND a.id::text=j.data->>'id'
  WHERE j.name IN ('collect','process','generate') AND NOT (j.name='generate' AND EXISTS(SELECT 1 FROM brief_requests r WHERE r.id::text=j.data->>'requestId'))
  UNION ALL
  SELECT 'request:'||r.id::text,'generate',
    CASE r.kind WHEN 'daily' THEN '日报' WHEN 'weekly' THEN '周报' ELSE '月报' END||' '||r.period_date::text||'（手动）',
    NULL,r.job_id,r.id,r.created_at,
    (SELECT min(h.started_on) FROM pgboss.job h WHERE h.name='generate' AND h.data->>'requestId'=r.id::text),
    coalesce(r.finished_at,j.completed_on),
    CASE WHEN r.state='waiting' THEN 'waiting_articles'
      WHEN j.state='cancelled' THEN 'cancelled'
      WHEN j.state='completed' AND EXISTS(SELECT 1 FROM processing_steps p WHERE p.run_key='job:'||j.id::text AND p.stage='task' AND p.state='waiting') THEN 'waiting_budget'
      WHEN r.state='completed' OR j.state='completed' THEN 'succeeded'
      WHEN r.state='failed' OR j.state='failed' THEN 'failed'
      ELSE coalesce(j.state::text,'created') END,
    coalesce(j.retry_count,0),coalesce(j.retry_limit,0),
    jsonb_build_object('kind',r.kind,'date',r.period_date::text,'requestId',r.id,'force',r.force,'expectedKey',r.expected_key),coalesce(r.error,j.output->>'message')
  FROM brief_requests r LEFT JOIN pgboss.job j ON j.id=r.job_id AND j.name='generate'
  UNION ALL
  SELECT 'article:'||a.id::text,'process',a.title,a.id::text,NULL::uuid,NULL::uuid,a.created_at,NULL::timestamptz,NULL::timestamptz,
    CASE WHEN a.state='failed' THEN 'failed' ELSE 'created' END,0,0,jsonb_build_object('id',a.id),NULL
  FROM articles a WHERE a.state IN ('pending','failed') AND NOT EXISTS(SELECT 1 FROM pgboss.job j WHERE j.name='process' AND j.data->>'id'=a.id::text)
)`;
export async function taskOverview(query = '', type = '', state = '') {
  const rows = await pool.query<ManagedTask>(
    `${taskProjection}
    SELECT * FROM unified WHERE ($1='' OR queue=$1) AND ($2='' OR state=$2)
    AND ($3='' OR name ILIKE '%'||$3||'%' OR id=$3 OR target_id=$3)
    ORDER BY created_on DESC,id DESC LIMIT 100`,
    [type, state, query.trim().slice(0, 200)],
  );
  return rows.rows;
}
export async function taskDetail(id: string) {
  if (!/^(job|request|article):[a-f0-9-]{36}$/.test(id)) return null;
  z.uuid().parse(id.split(':')[1]);
  const { rows } = await pool.query<ManagedTask>(
    `${taskProjection} SELECT * FROM unified WHERE id=$1`,
    [id],
  );
  const task = rows[0];
  if (!task) return null;
  const subject =
    task.queue === 'process'
      ? `article:${task.target_id}`
      : task.queue === 'collect'
        ? `source:${task.target_id}`
        : `brief:${task.data.kind}:${task.data.date}`;
  const [steps, article, source, attempts] = await Promise.all([
    pool.query<TaskStep>(
      `SELECT p.*,c.model,c.input_tokens,c.output_tokens,c.input_summary,c.response
      FROM processing_steps p LEFT JOIN model_calls c ON c.id=p.call_id WHERE p.subject=$1
      AND (p.run_key=$2 OR ($3::boolean AND p.stage<>'task') OR ($4::text IS NOT NULL AND EXISTS(SELECT 1 FROM pgboss.job j WHERE p.run_key='job:'||j.id::text AND j.data->>'requestId'=$4)))
      ORDER BY p.started_at DESC,p.id DESC LIMIT 100`,
      [subject, task.job_id ? `job:${task.job_id}` : '', task.queue === 'process', task.request_id],
    ),
    task.queue === 'process'
      ? pool.query(
          'SELECT a.*,e.title event_title FROM articles a LEFT JOIN events e ON e.id=a.event_id WHERE a.id::text=$1',
          [task.target_id],
        )
      : Promise.resolve({ rows: [] }),
    task.queue === 'collect'
      ? pool.query('SELECT id,name,url FROM sources WHERE id::text=$1', [task.target_id])
      : Promise.resolve({ rows: [] }),
    task.request_id
      ? pool.query(
          "SELECT id,state,created_on,started_on,completed_on,retry_count,retry_limit FROM pgboss.job WHERE name='generate' AND data->>'requestId'=$1 ORDER BY created_on DESC",
          [task.request_id],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  return {
    task,
    steps: steps.rows,
    ratingRules: ratingRuleSchema
      .array()
      .catch(defaultRatingRules)
      .parse(
        (steps.rows.find((s) => s.stage === 'validate')?.result as { ratingRules?: unknown } | null)
          ?.ratingRules,
      ),
    article: article.rows[0] ?? null,
    source: source.rows[0] ?? null,
    attempts: attempts.rows,
    edition: editionRecordSchema
      .array()
      .parse(steps.rows.find((s) => s.stage === 'edition')?.result ?? []),
  };
}
export async function retryManagedTask(id: string) {
  const detail = await taskDetail(id);
  if (!detail || detail.task.state !== 'failed') throw new Error('仅失败任务可以重试');
  const task = detail.task;
  if (task.queue === 'process') return retryArticle(task.target_id!);
  if (task.job_id) return retryJob(task.queue, task.job_id);
  throw new Error('原任务记录已不存在，请重新发起任务');
}
export async function retryArticle(id: string) {
  z.uuid().parse(id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const article = await client.query('SELECT state FROM articles WHERE id=$1 FOR UPDATE', [id]);
    if (!article.rows.length || !['pending', 'failed'].includes(article.rows[0].state))
      throw new Error('只有待处理或失败的资讯可以继续');
    const active = await client.query(
      "SELECT 1 FROM pgboss.job WHERE name='process' AND data->>'id'=$1 AND state IN ('created','active','retry')",
      [id],
    );
    if (active.rows.length) throw new Error('该资讯已在排队或执行');
    await client.query("UPDATE articles SET state='pending' WHERE id=$1", [id]);
    const jobId = await enqueue('process', { id, trigger: 'manual' }, id, {
      db: { executeSql: (sql, values) => client.query(sql, values) },
    });
    if (!jobId) throw new Error('该资讯已在排队或执行');
    await client.query('COMMIT');
    return jobId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function retryJob(name: string, id: string) {
  if (!['collect', 'process', 'generate'].includes(name)) throw new Error('不支持重试此任务');
  z.uuid().parse(id);
  const result = await pool.query(
    "SELECT * FROM pgboss.job WHERE id=$1 AND name=$2 AND state='failed'",
    [id, name],
  );
  if (!result.rows.length) throw new Error('仅失败任务可以重试');
  const job = result.rows[0];
  if (name === 'process') return retryArticle(job.data.id);
  if (name === 'generate' && job.data.requestId) {
    const request = await pool.query('SELECT force FROM brief_requests WHERE id=$1', [
      job.data.requestId,
    ]);
    const { requestGeneration } = await import('./generation-requests.ts');
    return requestGeneration(job.data.kind, job.data.date, {
      force: request.rows[0]?.force ?? false,
      expectedKey: job.data.expectedKey,
    });
  }
  const nextId = await enqueue(
    name as 'collect' | 'generate',
    { ...job.data, trigger: 'manual', ...(name === 'collect' ? { manual: true } : {}) },
    name === 'generate' ? `${job.data.kind}:${job.data.date}` : job.data.id,
  );
  if (nextId && name === 'generate' && job.data.reprocessBatchId) {
    await pool.query(
      "UPDATE reprocessing_batches SET state='generating',generation_job_id=$2,error=NULL,finished_at=NULL WHERE id=$1 AND state='failed'",
      [job.data.reprocessBatchId, nextId],
    );
  }
  return nextId;
}
