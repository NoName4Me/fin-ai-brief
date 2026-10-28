import { pool } from './db.ts';
export interface SourceMetric {
  id: string;
  name: string;
  enabled: boolean;
  last_fetched_at: Date | null;
  last_error: string | null;
  fetched: number;
  inserted: number;
  articles: number;
  relevant: number;
  ignored: number;
  events: number;
  selected: number;
  highlights: number;
}
export async function sourceMetrics() {
  const result = await pool.query<SourceMetric>(`WITH runs AS (
      SELECT source_id,
        sum(CASE WHEN jsonb_typeof(result->'fetched')='number' THEN (result->>'fetched')::int ELSE 0 END)::int fetched,
        sum(CASE WHEN jsonb_typeof(result->'inserted')='number' THEN (result->>'inserted')::int ELSE 0 END)::int inserted
      FROM collection_runs WHERE started_at >= now()-interval '30 days' AND state='succeeded' GROUP BY source_id
    ), recent AS (
      SELECT source_id,count(*)::int articles,count(*) FILTER (WHERE state='processed')::int relevant,
        count(*) FILTER (WHERE state='ignored')::int ignored,count(DISTINCT event_id) FILTER (WHERE state='processed')::int events
      FROM articles WHERE created_at >= now()-interval '30 days' GROUP BY source_id
    ), cited AS (
      SELECT DISTINCT a.source_id,b.id brief_id,item->>'eventId' event_id,
        EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.published->'highlights')='array' THEN b.published->'highlights' ELSE '[]'::jsonb END) h WHERE h->>'eventId'=item->>'eventId') highlight
      FROM briefs b
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(b.published->'items')='array' THEN b.published->'items' ELSE '[]'::jsonb END) item
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(item->'sources')='array' THEN item->'sources' ELSE '[]'::jsonb END) ref
      JOIN articles a ON a.url=ref->>'url'
      WHERE b.kind='daily' AND b.published_at >= now()-interval '30 days' AND a.source_id IS NOT NULL
    ), contribution AS (
      SELECT source_id,count(DISTINCT event_id)::int selected,count(DISTINCT event_id) FILTER (WHERE highlight)::int highlights FROM cited GROUP BY source_id
    )
    SELECT s.id,s.name,s.enabled,s.last_fetched_at,s.last_error,
      coalesce(r.fetched,0)::int fetched,coalesce(r.inserted,0)::int inserted,
      coalesce(a.articles,0)::int articles,coalesce(a.relevant,0)::int relevant,coalesce(a.ignored,0)::int ignored,coalesce(a.events,0)::int events,
      coalesce(c.selected,0)::int selected,coalesce(c.highlights,0)::int highlights
    FROM sources s LEFT JOIN runs r ON r.source_id=s.id LEFT JOIN recent a ON a.source_id=s.id LEFT JOIN contribution c ON c.source_id=s.id
    ORDER BY s.enabled DESC,coalesce(c.selected,0) DESC,coalesce(a.events,0) DESC,s.name`);
  return result.rows;
}
