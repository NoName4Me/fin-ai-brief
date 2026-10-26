import { pool } from './db.ts';
import { getSettings } from './settings.ts';
import { localDate, rangeFor } from './periods.ts';
import type { Settings } from './types.ts';
const day = 86_400_000;
export function mailRetentionCutoff(now: Date, config: Pick<Settings, 'mailRetentionDays'>) {
  return new Date(now.getTime() - config.mailRetentionDays * day);
}

// 保留尚未出刊的月报统计区间；7×24展示仍严格遵守保留天数。
export function latestMonthlyPeriod(now: Date, config: Settings) {
  const today = localDate(now);
  const make = (year: number, month: number) => {
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(config.monthlyDay, last)))
      .toISOString()
      .slice(0, 10);
  };
  const y = Number(today.slice(0, 4)),
    m = Number(today.slice(5, 7)) - 1;
  let date = make(y, m);
  const time = config.monthlyTime ?? config.dailyTime;
  if (new Date(`${date}T${time}:00+08:00`) > now) date = make(y, m - 1);
  return { date, range: rangeFor('monthly', date, time, config) };
}
export async function cleanupRetention(now = new Date()) {
  const config = await getSettings();
  if (!config.retentionEnabled) return { skipped: true, counts: {} as Record<string, number> };
  const client = await pool.connect();
  const counts: Record<string, number> = {};
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT pg_try_advisory_xact_lock(76140510) AS locked');
    if (!lock.rows[0].locked) {
      await client.query('ROLLBACK');
      return { skipped: true, counts };
    }
    const taskCutoff = new Date(now.getTime() - config.taskRetentionDays * day);
    let newsCutoff = new Date(now.getTime() - config.newsRetentionDays * day);
    if (config.monthlyEnabled) {
      const period = latestMonthlyPeriod(now, config);
      const published = await client.query(
        "SELECT 1 FROM briefs WHERE kind='monthly' AND period_date=$1 AND published IS NOT NULL",
        [period.date],
      );
      const floor =
        period.date < config.startDate || published.rows.length
          ? period.range.end
          : period.range.start;
      if (floor < newsCutoff) newsCutoff = floor;
    }
    await client.query(`CREATE TEMP TABLE retention_active ON COMMIT DROP AS
      SELECT subject FROM processing_steps WHERE state IN ('running','waiting')
      UNION SELECT subject FROM model_calls WHERE state='started' AND subject IS NOT NULL
      UNION SELECT CASE name WHEN 'process' THEN 'article:'||(data->>'id')
        WHEN 'collect' THEN 'source:'||(data->>'id')
        WHEN 'generate' THEN 'brief:'||(data->>'kind')||':'||(data->>'date')
        ELSE 'delivery:'||(data->>'id') END FROM pgboss.job WHERE state IN ('created','active','retry')`);
    await client.query(
      `CREATE TEMP TABLE retention_events ON COMMIT DROP AS
      SELECT e.id FROM events e WHERE e.occurred_at<$1
      AND NOT EXISTS(SELECT 1 FROM articles a JOIN retention_active r ON r.subject='article:'||a.id::text WHERE a.event_id=e.id)`,
      [newsCutoff],
    );
    const remove = async (name: string, sql: string, params: unknown[] = []) => {
      const result = await client.query(sql, params);
      counts[name] = result.rowCount ?? 0;
    };
    await remove(
      'articles',
      `DELETE FROM articles a WHERE published_at<$1
      AND NOT EXISTS(SELECT 1 FROM retention_active r WHERE r.subject='article:'||a.id::text)
      AND (event_id IS NULL OR event_id IN (SELECT id FROM retention_events))`,
      [newsCutoff],
    );
    await remove(
      'events',
      'DELETE FROM events e WHERE id IN (SELECT id FROM retention_events) AND NOT EXISTS(SELECT 1 FROM articles a WHERE a.event_id=e.id)',
    );
    await remove(
      'processingSteps',
      `DELETE FROM processing_steps s WHERE finished_at<$1 AND state IN ('succeeded','failed','skipped')
      AND NOT EXISTS(SELECT 1 FROM retention_active r WHERE r.subject=s.subject)`,
      [taskCutoff],
    );
    await remove(
      'modelCalls',
      `DELETE FROM model_calls m WHERE coalesce(finished_at,created_at)<$1 AND state IN ('succeeded','failed')
      AND NOT EXISTS(SELECT 1 FROM retention_active r WHERE r.subject=m.subject)
      AND NOT EXISTS(SELECT 1 FROM processing_steps s WHERE s.call_id=m.id)`,
      [taskCutoff],
    );
    await remove(
      'collectionRuns',
      "DELETE FROM collection_runs WHERE finished_at<$1 AND state IN ('succeeded','failed')",
      [taskCutoff],
    );
    await remove(
      'briefRequests',
      "DELETE FROM brief_requests WHERE finished_at<$1 AND state IN ('completed','failed')",
      [taskCutoff],
    );
    await remove(
      'jobs',
      `DELETE FROM pgboss.job j WHERE completed_on<$1 AND state IN ('completed','failed','cancelled')
      AND NOT EXISTS(SELECT 1 FROM processing_steps s WHERE s.run_key='job:'||j.id::text AND s.state IN ('running','waiting'))`,
      [taskCutoff],
    );
    await remove(
      'deliveries',
      "DELETE FROM deliveries WHERE created_at<$1 AND state IN ('sent','failed','uncertain')",
      [mailRetentionCutoff(now, config)],
    );
    await client.query('COMMIT');
    return { skipped: false, counts };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
