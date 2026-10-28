import { pool } from './db.ts';
import { localDate } from './periods.ts';
import { sourceMetrics } from './source-metrics.ts';
interface SourcePair {
  left_id: string;
  left_name: string;
  left_events: number;
  right_id: string;
  right_name: string;
  right_events: number;
  shared: number;
}
export async function dashboardCharts() {
  const date = localDate();
  const [sources, trend, pairs] = await Promise.all([
    sourceMetrics(),
    pool.query<{ date: string; incoming: number }>(
      `WITH days AS (
      SELECT generate_series($1::date - 13,$1::date,interval '1 day')::date AS metric_date
    ), incoming AS (
      SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS metric_date,count(*)::int incoming FROM articles
      WHERE created_at >= ($1::date - 13)::timestamp AT TIME ZONE 'Asia/Shanghai'
        AND created_at < ($1::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai'
      GROUP BY 1
    ) SELECT d.metric_date::text AS date,coalesce(i.incoming,0)::int incoming FROM days d LEFT JOIN incoming i USING(metric_date) ORDER BY d.metric_date`,
      [date],
    ),
    pool.query<SourcePair>(`WITH source_events AS (
      SELECT DISTINCT source_id,event_id FROM articles
      WHERE source_id IS NOT NULL AND event_id IS NOT NULL AND state='processed'
        AND created_at >= now()-interval '30 days'
    ), totals AS (
      SELECT source_id,count(*)::int total FROM source_events GROUP BY source_id
    ), common AS (
      SELECT a.source_id left_id,b.source_id right_id,count(*)::int shared
      FROM source_events a JOIN source_events b ON a.event_id=b.event_id AND a.source_id < b.source_id
      GROUP BY a.source_id,b.source_id
    ) SELECT a.id left_id,a.name left_name,ta.total left_events,
      b.id right_id,b.name right_name,tb.total right_events,c.shared
    FROM common c JOIN sources a ON a.id=c.left_id JOIN sources b ON b.id=c.right_id
    JOIN totals ta ON ta.source_id=c.left_id JOIN totals tb ON tb.source_id=c.right_id
    ORDER BY c.shared::numeric / least(ta.total,tb.total) DESC,c.shared DESC,a.name,b.name
    LIMIT 3`),
  ]);
  const contributions = sources
    .filter((s) => s.selected > 0)
    .sort(
      (a, b) =>
        b.selected - a.selected || b.highlights - a.highlights || a.name.localeCompare(b.name),
    )
    .slice(0, 5);
  const overlap = pairs.rows.map((pair) => ({
    ...pair,
    leftRate: (pair.shared / pair.left_events) * 100,
    rightRate: (pair.shared / pair.right_events) * 100,
  }));
  return { contributions, overlap, trend: trend.rows };
}
