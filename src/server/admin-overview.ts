import { explainEditionRecord } from './edition-status.ts';
import { latestEditionTask } from './edition-history.ts';
import { pool } from './db.ts';
import { getSettings } from './settings.ts';
import { modelUsage } from './model.ts';
import { localDate } from './periods.ts';

interface EditionSection {
  section: string;
  status: string;
  candidate_count: number;
  selected_count: number;
  reason: string;
  period_date: string;
  details?: { rating?: number | null; selected?: boolean; reason?: string }[];
}
interface Issue {
  id: string;
  period_date: string;
  title: string | null;
  has_draft: boolean;
  is_published: boolean;
  published_at: Date | null;
}
async function latestGeneration(date: string) {
  const exists = await pool.query("SELECT to_regclass('pgboss.job') IS NOT NULL ready");
  const jobs = exists.rows[0].ready
    ? `
    UNION ALL
    SELECT CASE WHEN j.state='completed' AND EXISTS(
      SELECT 1 FROM processing_steps p WHERE p.run_key='job:'||j.id::text AND p.stage='task' AND p.state='waiting'
    ) THEN 'waiting_budget' ELSE j.state::text END state,j.output->>'message' error,j.created_on created_at
    FROM pgboss.job j WHERE j.name='generate' AND j.data->>'kind'='daily' AND j.data->>'date'=$1::text`
    : '';
  return pool.query<{ state: string; error: string | null }>(
    `SELECT state,error FROM (
      SELECT state,error,created_at FROM brief_requests WHERE kind='daily' AND period_date=$1::date
      ${jobs}
    ) runs ORDER BY created_at DESC LIMIT 1`,
    [date],
  );
}
export async function adminOverview(now = new Date()) {
  const date = localDate(now);
  const start = new Date(`${date}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 86400000);
  const [config, usage, counts, health, issues, sections, generation] = await Promise.all([
    getSettings(),
    modelUsage(),
    pool.query<{
      published: number;
      incoming: number;
      incoming_relevant: number;
      incoming_ignored: number;
      incoming_pending: number;
      incoming_failed: number;
      pending: number;
      failed: number;
      drafts: number;
    }>(
      `WITH incoming_today AS (
        SELECT count(*)::int total,
          count(*) FILTER (WHERE state='processed')::int relevant,
          count(*) FILTER (WHERE state='ignored')::int ignored,
          count(*) FILTER (WHERE state='pending')::int pending,
          count(*) FILTER (WHERE state='failed')::int failed
        FROM articles WHERE created_at >= $1 AND created_at < $2
      ) SELECT
        (SELECT count(*)::int FROM briefs WHERE kind='daily' AND published IS NOT NULL) published,
        i.total incoming,i.relevant incoming_relevant,i.ignored incoming_ignored,i.pending incoming_pending,i.failed incoming_failed,
        (SELECT count(*)::int FROM articles WHERE state='pending') pending,
        (SELECT count(*)::int FROM articles WHERE state='failed') failed,
        (SELECT count(*)::int FROM briefs WHERE kind='daily' AND draft IS NOT NULL) drafts FROM incoming_today i`,
      [start, end],
    ),
    pool.query<{ id: string; name: string; state: string; last_error: string | null }>(
      `SELECT id,name,last_error,CASE
        WHEN last_fetched_at IS NULL THEN 'new'
        WHEN failure_count >= 3 AND last_error IS NOT NULL THEN 'failed'
        WHEN last_error IS NOT NULL THEN 'retry'
        WHEN last_fetched_at < $1::timestamptz - greatest(interval_minutes * 2,60) * interval '1 minute'
          AND (next_fetch_at IS NULL OR next_fetch_at < $1::timestamptz - interval '15 minutes') THEN 'overdue'
        ELSE 'healthy' END state
      FROM sources WHERE enabled ORDER BY name,id`,
      [now],
    ),
    pool.query<Issue>(
      `SELECT id,period_date::text,coalesce(draft->>'title',published->>'title') title,
        draft IS NOT NULL has_draft,published IS NOT NULL is_published,published_at
      FROM briefs WHERE kind='daily' AND period_date <= $1 ORDER BY period_date DESC LIMIT 6`,
      [date],
    ),
    pool.query<EditionSection>(
      `SELECT section,status,candidate_count,selected_count,reason,period_date::text,details
      FROM edition_runs WHERE period_date=(SELECT max(period_date) FROM edition_runs WHERE period_date <= $1)
      ORDER BY section`,
      [date],
    ),
    latestGeneration(date),
  ]);
  const editionTask = sections.rows[0]
    ? await latestEditionTask(sections.rows[0].period_date)
    : null;
  const explainedSections = sections.rows.map((section) =>
    explainEditionRecord(section, editionTask?.failed),
  );
  const today = issues.rows.find((issue) => issue.period_date === date);
  const run = generation.rows[0];
  const running =
    run &&
    ['created', 'queued', 'active', 'retry', 'waiting', 'waiting_budget'].includes(run.state);
  const todaySections = explainedSections.filter((section) => section.period_date === date);
  const status = running
    ? run.state === 'waiting_budget'
      ? '等待模型额度'
      : run.state === 'waiting'
        ? '等待资讯处理'
        : '生成中'
    : run?.state === 'failed'
      ? '生成失败'
      : today?.has_draft
        ? '待审核'
        : today?.is_published
          ? '已发布'
          : todaySections.some((section) => section.status === 'error')
            ? '出刊异常'
            : todaySections.length &&
                todaySections.every((section) =>
                  ['skipped', 'unscheduled'].includes(section.status),
                )
              ? '本期无合格内容'
              : !config.dailyEnabled
                ? '自动出刊已暂停'
                : date < config.startDate
                  ? '尚未到启用日期'
                  : now < new Date(`${date}T08:00:00+08:00`)
                    ? '未到截稿时间'
                    : '尚未生成';
  // Paused collection is not a scheduling fault. Actual failures and uncollected sources remain visible.
  const sourceRows = health.rows.map((source) => ({
    ...source,
    state: source.state === 'overdue' && !config.collectionEnabled ? 'paused' : source.state,
  }));
  return {
    date,
    config,
    usage,
    counts: counts.rows[0],
    sources: sourceRows,
    issues: issues.rows,
    sections: explainedSections,
    editionTask,
    today,
    status,
    generationError: run?.state === 'failed' ? run.error : null,
  };
}
