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
export { stateNames, taskTypes } from './admin-task-labels.ts';
export { stageNames } from './task-labels.ts';
import { taskTypes } from './admin-task-labels.ts';
import { explainEditionRecord } from './edition-status.ts';
import { retryBatchFailures } from './admin-reprocessing.ts';
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
    batchId?: string;
    total?: number;
    processed?: number;
    ignored?: number;
    failed?: number;
    waiting?: number;
    queued?: number;
  };
  error: string | null;
  attempt_count: number;
  latest_job_id: string | null;
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
    j.retry_count,j.retry_limit,j.data,
    coalesce(j.output->>'message',j.output->'value'->>'message',j.output->>'error') error,
    CASE WHEN j.name='process' THEN count(*) OVER (PARTITION BY j.data->>'id') ELSE 1 END::int attempt_count,
    CASE WHEN j.name='process' THEN first_value(j.id::text) OVER (PARTITION BY j.data->>'id' ORDER BY j.created_on DESC,j.id DESC) ELSE j.id::text END latest_job_id
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
    jsonb_build_object('kind',r.kind,'date',r.period_date::text,'requestId',r.id,'force',r.force,'expectedKey',r.expected_key),
    coalesce(r.error,j.output->>'message',j.output->'value'->>'message',j.output->>'error'),
    1,NULL::text
  FROM brief_requests r LEFT JOIN pgboss.job j ON j.id=r.job_id AND j.name='generate'
  UNION ALL
  SELECT 'article:'||a.id::text,'process',a.title,a.id::text,NULL::uuid,NULL::uuid,a.created_at,NULL::timestamptz,NULL::timestamptz,
    CASE WHEN a.state='failed' THEN 'failed' ELSE 'created' END,0,0,jsonb_build_object('id',a.id),NULL,1,NULL::text
  FROM articles a WHERE a.state IN ('pending','failed') AND NOT EXISTS(SELECT 1 FROM pgboss.job j WHERE j.name='process' AND j.data->>'id'=a.id::text)
  UNION ALL
  SELECT 'batch:'||b.id::text,'reprocess',
    CASE WHEN b.regenerate_date IS NOT NULL THEN b.regenerate_date::text||' 日报：重处理并重新生成'
      ELSE to_char(b.range_start AT TIME ZONE 'Asia/Shanghai','MM-DD HH24:MI')||'—'||to_char(b.range_end AT TIME ZONE 'Asia/Shanghai','MM-DD HH24:MI')||' 资讯重处理' END,
    b.id::text,b.generation_job_id,NULL::uuid,b.created_at,
    (SELECT min(j.started_on) FROM pgboss.job j WHERE j.data->>'reprocessBatchId'=b.id::text),b.finished_at,
    CASE b.state WHEN 'waiting' THEN 'created' WHEN 'processing' THEN CASE WHEN count(*) FILTER(WHERE i.state IN ('waiting','queued'))=0 AND b.regenerate_date IS NOT NULL THEN 'waiting_articles' ELSE 'active' END WHEN 'completed' THEN 'succeeded' ELSE b.state END,
    0,0,
    jsonb_build_object('batchId',b.id,'date',b.regenerate_date::text,'total',b.total,
      'processed',count(*) FILTER(WHERE i.state='processed'),'ignored',count(*) FILTER(WHERE i.state='ignored'),
      'failed',count(*) FILTER(WHERE i.state='failed'),'waiting',count(*) FILTER(WHERE i.state='waiting'),'queued',count(*) FILTER(WHERE i.state='queued')),
    b.error,1,NULL::text
  FROM reprocessing_batches b LEFT JOIN reprocessing_items i ON i.batch_id=b.id GROUP BY b.id

)`;
export async function taskOverview(query = '', type = '', state = '') {
  const rows = await pool.query<ManagedTask>(
    `${taskProjection},
    ranked AS (
      SELECT *,row_number() OVER (
        PARTITION BY CASE WHEN queue='process' THEN 'process:'||target_id ELSE id END
        ORDER BY created_on DESC,id DESC
      ) position
      FROM unified WHERE ($1='' OR queue=$1)
      AND ($3='' OR name ILIKE '%'||$3||'%' OR id=$3 OR target_id=$3)
    )
    SELECT * FROM ranked WHERE position=1 AND ($2='' OR state=$2)
      AND NOT ((queue='process' OR (queue='generate' AND $1<>'generate')) AND data->>'reprocessBatchId' IS NOT NULL)
      AND NOT (queue='process' AND EXISTS (
        SELECT 1 FROM reprocessing_items i JOIN reprocessing_batches b ON b.id=i.batch_id
        WHERE i.article_id::text=ranked.target_id AND (
          (b.state IN ('waiting','processing','generating') AND i.state IN ('waiting','queued'))
          OR (ranked.job_id IS NULL AND i.state IN ('failed','waiting','queued'))
        )
      ))
    ORDER BY CASE WHEN queue='reprocess' AND state IN ('created','active','generating','waiting_articles','waiting_budget') THEN 0 ELSE 1 END,CASE WHEN queue='reprocess' THEN coalesce(completed_on,created_on) ELSE created_on END DESC,id DESC LIMIT 100`,
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
  const [steps, article, source, attempts, attemptsForArticle] = await Promise.all([
    pool.query<TaskStep>(
      `SELECT p.*,c.model,c.input_tokens,c.output_tokens,c.input_summary,c.response
      FROM processing_steps p LEFT JOIN model_calls c ON c.id=p.call_id WHERE p.subject=$1
      AND (
        ($3::boolean AND (
          p.stage<>'task' OR p.run_key IN (
            SELECT 'job:'||j.id::text FROM pgboss.job j
            WHERE j.name='process' AND j.data->>'id'=$5
          )
        ))
        OR (NOT $3::boolean AND p.run_key=$2)
        OR ($4::text IS NOT NULL AND EXISTS(
          SELECT 1 FROM pgboss.job j
          WHERE p.run_key='job:'||j.id::text AND j.data->>'requestId'=$4
        ))
      )
      ORDER BY p.started_at DESC,p.id DESC LIMIT 100`,
      [
        subject,
        task.latest_job_id ? `job:${task.latest_job_id}` : '',
        task.queue === 'process',
        task.request_id,
        task.target_id,
      ],
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
    task.queue === 'process'
      ? pool.query(
          `SELECT j.id,j.created_on,j.started_on,j.completed_on,j.state,j.data->>'trigger' trigger,
          j.retry_count,j.retry_limit,
          coalesce(j.output->>'message',j.output->'value'->>'message',j.output->>'error') error,
          EXISTS(SELECT 1 FROM processing_steps p WHERE p.run_key='job:'||j.id::text AND p.stage='task' AND p.state='waiting') waiting
          FROM pgboss.job j WHERE j.name='process' AND j.data->>'id'=$1 ORDER BY j.created_on DESC`,
          [task.target_id],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  const assignedSteps = new Set<string>();
  const articleAttempts = [...attemptsForArticle.rows]
    .sort((a, b) => new Date(a.created_on).getTime() - new Date(b.created_on).getTime())
    .map((row) => {
      const direct = steps.rows.filter(
        (step) =>
          step.run_key === `job:${row.id}` || step.run_key.startsWith(`job:${row.id}:retry:`),
      );
      direct.forEach((step) => assignedSteps.add(step.id));
      const from = new Date(row.created_on).getTime();
      const to = row.completed_on ? new Date(row.completed_on).getTime() : Date.now() + 1;
      const business = steps.rows.filter(
        (step) =>
          !step.run_key.startsWith('job:') &&
          !assignedSteps.has(step.id) &&
          new Date(step.started_at).getTime() >= from &&
          new Date(step.started_at).getTime() <= to,
      );
      business.forEach((step) => assignedSteps.add(step.id));
      const retryStep: TaskStep | null =
        row.retry_count > 0 && !direct.some((step) => step.stage === 'retry')
          ? {
              id: `retry:${row.id}:${row.retry_count}`,
              subject,
              run_key: `job:${row.id}:retry:${row.retry_count}`,
              stage: 'retry',
              state:
                row.state === 'retry'
                  ? 'retry'
                  : row.state === 'completed'
                    ? 'succeeded'
                    : row.state === 'failed'
                      ? 'failed'
                      : 'running',
              started_at: row.started_on ?? row.created_on,
              finished_at: row.completed_on,
              result: null,
              error: row.state === 'failed' ? row.error : null,
              call_id: null,
              model: null,
              input_tokens: null,
              output_tokens: null,
              input_summary: null,
              response: null,
            }
          : null;
      const groupedSteps = [...direct, ...business, ...(retryStep ? [retryStep] : [])].filter(
        (step) => step.stage !== 'task' && step.stage !== 'edition',
      );
      const failureStep = groupedSteps.find(
        (step) => step.stage !== 'retry' && (step.state === 'failed' || step.error),
      );
      const interruptedMessage = failureStep?.error ?? row.error ?? '任务已中断';
      const attemptSteps =
        row.state === 'failed'
          ? groupedSteps.map((step) =>
              step.state === 'running'
                ? {
                    ...step,
                    state: 'failed',
                    finished_at: row.completed_on,
                    error: step.error ?? interruptedMessage,
                  }
                : step,
            )
          : groupedSteps;
      return {
        id: row.id,
        created_on: row.created_on,
        started_on: row.started_on,
        completed_on: row.completed_on,
        trigger: row.trigger,
        retry_count: row.retry_count,
        retry_limit: row.retry_limit,
        state: row.waiting ? 'waiting_budget' : row.state === 'completed' ? 'succeeded' : row.state,
        error: failureStep?.error ?? row.error,
        steps: attemptSteps.sort((a, b) => {
          if (a.stage === 'retry' && b.stage !== 'retry') return 1;
          if (b.stage === 'retry' && a.stage !== 'retry') return -1;
          return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
        }),
      };
    })
    .reverse();
  const failed =
    ['failed', 'retry'].includes(task.state) ||
    (task.queue === 'process' && article.rows[0]?.state === 'failed');
  const latestStep = failed
    ? (task.queue === 'process' ? articleAttempts[0]?.steps : steps.rows).find(
        (step) => step.stage !== 'task' && (step.state === 'failed' || step.error),
      )
    : null;
  const interruptedTaskStep =
    task.state === 'failed'
      ? steps.rows.find(
          (step) =>
            step.state === 'running' &&
            (step.run_key === `job:${task.job_id}` ||
              step.run_key.startsWith(`job:${task.job_id}:retry:`)),
        )
      : null;
  const displaySteps =
    task.state === 'failed' && interruptedTaskStep
      ? steps.rows.map((step) =>
          step.id === interruptedTaskStep.id
            ? {
                ...step,
                state: 'failed',
                finished_at: task.completed_on,
                error: task.error ?? '任务已中断',
              }
            : step,
        )
      : steps.rows;
  return {
    task,
    steps: displaySteps,
    attemptsForArticle: articleAttempts,
    ratingRules: ratingRuleSchema
      .array()
      .catch(defaultRatingRules)
      .parse(
        (
          displaySteps.find((s) => s.stage === 'validate')?.result as {
            ratingRules?: unknown;
          } | null
        )?.ratingRules,
      ),
    article: article.rows[0] ?? null,
    failure: latestStep
      ? { stage: latestStep.stage, error: latestStep.error }
      : task.state === 'failed' && interruptedTaskStep
        ? { stage: interruptedTaskStep.stage, error: task.error ?? '任务已中断' }
        : null,
    source: source.rows[0] ?? null,
    attempts: attempts.rows,
    edition: editionRecordSchema
      .array()
      .parse(displaySteps.find((s) => s.stage === 'edition')?.result ?? [])
      .map((row) => explainEditionRecord(row)),
  };
}
export async function retryManagedTask(id: string) {
  if (id.startsWith('batch:')) return retryBatchFailures(id.slice(6));
  const detail = await taskDetail(id);
  if (!detail) throw new Error('任务不存在');
  const task = detail.task;
  if (task.queue === 'process' && task.target_id) {
    const article = await pool.query('SELECT state FROM articles WHERE id=$1', [task.target_id]);
    if (!article.rows.length) throw new Error('原资讯记录已不存在，请重新采集');
    if (article.rows[0].state === 'pending') throw new Error('该资讯已在排队或执行');
    if (article.rows[0].state !== 'failed') throw new Error('仅失败的资讯可以重试');
    return retryArticle(task.target_id);
  }
  if (task.state !== 'failed') throw new Error('仅失败任务可以重试');
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
