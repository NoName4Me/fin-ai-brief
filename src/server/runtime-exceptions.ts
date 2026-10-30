import { pool } from './db.ts';
import { publicationCycle } from './periods.ts';

type Counts = { collection: number; processing: number; generation: number; total: number };
export async function runtimeExceptions(now: Date, dailyTime: string) {
  const cycle = publicationCycle(now, dailyTime);
  const { rows } = await pool.query<
    Counts & {
      previous_collection: number;
      previous_processing: number;
      previous_generation: number;
      previous_total: number;
    }
  >(
    `WITH latest AS (
      SELECT DISTINCT ON (subject) subject,state,coalesce(finished_at,started_at) at
      FROM processing_steps WHERE stage='task' AND started_at <= $1
      ORDER BY subject,started_at DESC,id DESC
    ), failures AS (
      SELECT DISTINCT ON (f.subject) f.subject,f.started_at,coalesce(f.finished_at,f.started_at) at
      FROM processing_steps f WHERE f.stage='task' AND f.state='failed'
        AND coalesce(f.finished_at,f.started_at) >= $2 AND coalesce(f.finished_at,f.started_at) <= $1
        AND NOT EXISTS(SELECT 1 FROM processing_steps ok WHERE ok.subject=f.subject AND ok.stage='task'
          AND ok.state='succeeded' AND ok.started_at > f.started_at AND ok.finished_at <= $1)
      ORDER BY f.subject,f.started_at DESC,f.id DESC
    ), current_errors AS (
      SELECT 'collection' kind,'source:'||s.id::text subject FROM sources s
      WHERE s.enabled AND s.last_error IS NOT NULL AND s.last_fetched_at >= $2 AND s.last_fetched_at <= $1
      UNION
      SELECT 'processing','article:'||a.id::text FROM articles a
      LEFT JOIN latest l ON l.subject='article:'||a.id::text
      LEFT JOIN failures f ON f.subject='article:'||a.id::text
      WHERE (a.state IN ('failed','pending') AND f.subject IS NOT NULL)
        OR (a.state='failed' AND l.subject IS NULL AND a.created_at >= $2 AND a.created_at <= $1)
      UNION
      SELECT 'generation',f.subject FROM failures f
      WHERE f.subject LIKE 'brief:daily:%'
        AND NOT EXISTS(SELECT 1 FROM briefs b WHERE 'brief:daily:'||b.period_date::text=f.subject
          AND b.kind='daily' AND b.published IS NOT NULL AND b.published_at >= f.started_at AND b.published_at <= $1)
    ), previous_errors AS (
      SELECT 'collection' kind,'source:'||source_id::text subject FROM collection_runs
      WHERE state='failed' AND source_id IS NOT NULL AND coalesce(finished_at,started_at) >= $3 AND coalesce(finished_at,started_at) < $2
      UNION
      SELECT 'collection','source:'||id::text FROM sources
      WHERE last_error IS NOT NULL AND last_fetched_at >= $3 AND last_fetched_at < $2
      UNION
      SELECT CASE WHEN subject LIKE 'source:%' THEN 'collection' WHEN subject LIKE 'article:%' THEN 'processing' ELSE 'generation' END,subject
      FROM processing_steps WHERE stage='task' AND state='failed'
        AND (subject LIKE 'source:%' OR subject LIKE 'article:%' OR subject LIKE 'brief:daily:%')
        AND coalesce(finished_at,started_at) >= $3 AND coalesce(finished_at,started_at) < $2
    ) SELECT
      (SELECT count(*)::int FROM current_errors WHERE kind='collection') collection,
      (SELECT count(*)::int FROM current_errors WHERE kind='processing') processing,
      (SELECT count(*)::int FROM current_errors WHERE kind='generation') generation,
      (SELECT count(*)::int FROM current_errors) total,
      (SELECT count(*)::int FROM previous_errors WHERE kind='collection') previous_collection,
      (SELECT count(*)::int FROM previous_errors WHERE kind='processing') previous_processing,
      (SELECT count(*)::int FROM previous_errors WHERE kind='generation') previous_generation,
      (SELECT count(*)::int FROM previous_errors) previous_total`,
    [now, cycle.start, cycle.previousStart],
  );
  const row = rows[0];
  return {
    since: cycle.start,
    until: now,
    collection: row.collection,
    processing: row.processing,
    generation: row.generation,
    total: row.total,
    previous: {
      since: cycle.previousStart,
      until: cycle.start,
      collection: row.previous_collection,
      processing: row.previous_processing,
      generation: row.previous_generation,
      total: row.previous_total,
    },
  };
}
