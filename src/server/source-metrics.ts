import type { RankingSnapshot } from './types.ts';
import { pool } from './db.ts';
import { getSettings } from './settings.ts';
import { ratingForEditorial } from './editorial.ts';
import { localDate, validDate } from './periods.ts';
export interface SourceMetric {
  source_state: string;
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
  discovered: number;
  pending: number;
  failed: number;
  qualified: number;
  exclusive: number;
  incremental: number;
  first: number;
  calls: number;
  succeeded_runs: number;
  failed_runs: number;
  repeated_items: number;
  observed_items: number;
  title_only: number;
}
export interface SourceDiscovery {
  source_id: string;
  url: string;
  title: string;
  published_at: Date | null;
  published_precision: string | null;
  snapshot: RankingSnapshot | null;
  excerpt: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  inserted: boolean;
  material_kind: string;
  article_id: string | null;
  state: string | null;
  event_id: string | null;
  event_title: string | null;
  assessment: unknown;
  score: number | null;
  rating_rules: unknown;
  review_note: string | null;
  development: boolean;
  selected: boolean;
  highlight: boolean;
  has_edition: boolean;
  editions: { id: string; date: string }[];
  rating: number | null;
  qualified: boolean;
  relation: 'new' | 'update' | 'duplicate' | null;
  peers: {
    source_id: string;
    name: string;
    first_seen_at: Date;
    url: string;
    title: string;
    development: boolean;
    qualified: boolean;
  }[];
}
export function discoveryRange(date?: string, days = 30, now = new Date()) {
  if (date) {
    if (!validDate(date) || date > localDate(now)) throw new Error('采集日期无效');
    const start = new Date(`${date}T00:00:00+08:00`);
    return { start, end: new Date(start.getTime() + 86400_000) };
  }
  const end = new Date(`${localDate(now)}T00:00:00+08:00`);
  return {
    start: new Date(end.getTime() - (days - 1) * 86400_000),
    end: new Date(end.getTime() + 86400_000),
  };
}
export async function sourceQualityData(
  days = 30,
  date?: string,
  now = new Date(),
  requestedRange?: { start: Date; end: Date },
) {
  const range = requestedRange ?? discoveryRange(date, days, now);
  const config = await getSettings();
  const [sources, observations, runs, repetitions, calls] = await Promise.all([
    pool.query<
      Pick<
        SourceMetric,
        'id' | 'name' | 'enabled' | 'last_fetched_at' | 'last_error' | 'source_state'
      >
    >(
      `SELECT id,name,enabled,last_fetched_at,last_error,CASE
        WHEN NOT enabled THEN 'disabled'
        WHEN last_fetched_at IS NULL THEN 'new'
        WHEN failure_count>=3 AND last_error IS NOT NULL THEN 'failed'
        WHEN last_error IS NOT NULL THEN 'retry'
        WHEN last_fetched_at<$1::timestamptz-greatest(interval_minutes*2,60)*interval '1 minute'
          AND (next_fetch_at IS NULL OR next_fetch_at<$1::timestamptz-interval '15 minutes') THEN CASE WHEN $2 THEN 'overdue' ELSE 'paused' END
        ELSE 'healthy' END source_state FROM sources ORDER BY sort_order,created_at,id`,
      [now, config.collectionEnabled],
    ),
    pool.query<SourceDiscovery>(
      `SELECT d.*,a.published_precision,a.provenance->'snapshot' AS snapshot,a.excerpt,a.id article_id,coalesce(a.state,CASE WHEN EXISTS(SELECT 1 FROM collection_items ci WHERE ci.source_id=d.source_id AND ci.url=d.url AND ci.outcome='failed') THEN 'failed' WHEN EXISTS(SELECT 1 FROM collection_items ci WHERE ci.source_id=d.source_id AND ci.url=d.url AND ci.outcome='invalid') THEN 'invalid' ELSE 'removed' END) state,a.event_id,e.title event_title,a.assessment,e.score,a.review_note,
      (SELECT p.result->'ratingRules' FROM processing_steps p WHERE p.subject='article:'||a.id::text AND p.stage='validate' AND p.state='succeeded' ORDER BY p.finished_at DESC LIMIT 1) rating_rules,
      EXISTS(SELECT 1 FROM event_developments v WHERE v.article_id=a.id AND v.event_id=a.event_id) development,
      EXISTS(SELECT 1 FROM briefs b WHERE b.kind='daily' AND b.published IS NOT NULL
        AND a.published_at>=nullif(b.published->>'rangeStart','')::timestamptz AND a.published_at<nullif(b.published->>'rangeEnd','')::timestamptz) has_edition,
      coalesce(c.editions,'[]'::jsonb) editions, coalesce(c.selected,false) selected,coalesce(c.highlight,false) highlight
      FROM source_discoveries d LEFT JOIN articles a ON a.url=d.url LEFT JOIN events e ON e.id=a.event_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(DISTINCT jsonb_build_object('id',b.id,'date',b.period_date::text)) editions,
          bool_or(true) selected,bool_or(EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(b.published->'highlights','[]'::jsonb)) h WHERE h->>'eventId'=a.event_id::text)) highlight
        FROM briefs b WHERE b.kind='daily' AND b.published IS NOT NULL
          AND b.published_at>=d.first_seen_at AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(b.published->'items','[]'::jsonb)) i CROSS JOIN LATERAL jsonb_array_elements(coalesce(i->'sources','[]'::jsonb)) ref WHERE i->>'eventId'=a.event_id::text AND ref->>'url'=d.url)
      ) c ON true
      WHERE d.first_seen_at<$2 AND (d.last_seen_at >= $1 OR EXISTS(
        SELECT 1 FROM source_discoveries peer JOIN articles pa ON pa.url=peer.url
        WHERE pa.event_id=a.event_id AND peer.first_seen_at >= $1 AND peer.first_seen_at<$2))
      ORDER BY d.first_seen_at,d.source_id,d.url`,
      [range.start, range.end],
    ),
    pool.query<{ source_id: string; fetched: number; succeeded_runs: number; failed_runs: number }>(
      `SELECT source_id,
      coalesce(sum(CASE WHEN jsonb_typeof(result->'fetched')='number' THEN (result->>'fetched')::int ELSE 0 END),0)::int fetched,
      count(*) FILTER(WHERE state='succeeded')::int succeeded_runs,count(*) FILTER(WHERE state='failed')::int failed_runs
      FROM collection_runs WHERE started_at >= $1 AND started_at<$2 GROUP BY source_id`,
      [range.start, range.end],
    ),
    pool.query<{ source_id: string; repeated_items: number; observed_items: number }>(
      `SELECT r.source_id,
      count(*) FILTER(WHERE i.outcome='repeated')::int repeated_items,
      count(*) FILTER(WHERE i.outcome IN('new','known','repeated'))::int observed_items
      FROM collection_items i JOIN collection_runs r ON r.id=i.run_id
      WHERE r.started_at >= $1 AND r.started_at<$2 GROUP BY r.source_id`,
      [range.start, range.end],
    ),
    pool.query<{ source_id: string; calls: number }>(
      `SELECT a.source_id,coalesce(sum(greatest(m.api_attempts,1)),0)::int calls
      FROM model_calls m JOIN articles a ON m.subject='article:'||a.id::text
      JOIN source_discoveries d ON d.source_id=a.source_id AND d.url=a.url
      WHERE d.first_seen_at >= $1 AND d.first_seen_at<$2 GROUP BY a.source_id`,
      [range.start, range.end],
    ),
  ]);
  const names = new Map(sources.rows.map((s) => [s.id, s.name]));
  const byEvent = new Map<string, SourceDiscovery[]>();
  for (const row of observations.rows)
    if (row.state === 'processed' && row.event_id) {
      const group = byEvent.get(row.event_id) ?? [];
      group.push(row);
      byEvent.set(row.event_id, group);
    }
  const rows = observations.rows
    .map((row) => {
      const peers = row.event_id ? (byEvent.get(row.event_id) ?? []) : [];
      const ownDevelopment = row.development && row.inserted;
      const earlier = peers.some((p) => p.development && p.first_seen_at < row.first_seen_at);
      return {
        ...row,
        rating: ratingForEditorial(
          {
            assessment: row.assessment,
            ...(row.rating_rules ? { ratingRules: row.rating_rules } : {}),
          },
          config.ratingRules,
        ),
        qualified:
          row.state === 'processed' &&
          Number(row.score) > 0 &&
          (ratingForEditorial(
            {
              assessment: row.assessment,
              ...(row.rating_rules ? { ratingRules: row.rating_rules } : {}),
            },
            config.ratingRules,
          ) ?? 0) >= config.candidateRating,
        relation:
          row.state === 'processed'
            ? ownDevelopment
              ? earlier
                ? 'update'
                : 'new'
              : 'duplicate'
            : null,
        peers: peers
          .filter((p) => p.source_id !== row.source_id)
          .map((p) => ({
            source_id: p.source_id,
            name: names.get(p.source_id) ?? '已删除信源',
            first_seen_at: p.first_seen_at,
            url: p.url,
            title: p.title,
            development: p.development && p.inserted,
            qualified:
              Number(p.score) > 0 &&
              (ratingForEditorial(
                {
                  assessment: p.assessment,
                  ...(p.rating_rules ? { ratingRules: p.rating_rules } : {}),
                },
                config.ratingRules,
              ) ?? 0) >= config.candidateRating,
          })),
      } as SourceDiscovery;
    })
    .filter((row) => row.first_seen_at >= range.start && row.first_seen_at < range.end);
  const metrics = sources.rows.map((source) => {
    const items = rows.filter((r) => r.source_id === source.id);
    const set = (items: SourceDiscovery[]) =>
      new Set(items.flatMap((r) => (r.event_id ? [r.event_id] : []))).size;
    const qualified = items.filter((r) => r.qualified);
    return {
      ...source,
      discovered: items.length,
      articles: items.filter((r) => r.inserted).length,
      inserted: items.filter((r) => r.inserted).length,
      relevant: items.filter((r) => r.state === 'processed').length,
      ignored: items.filter((r) => r.state === 'ignored').length,
      pending: items.filter((r) => r.state === 'pending').length,
      failed: items.filter((r) => r.state === 'failed').length,
      events: set(items.filter((r) => r.state === 'processed')),
      qualified: set(qualified),
      exclusive: set(qualified.filter((r) => !r.peers.some((p) => p.qualified))),
      incremental: set(qualified.filter((r) => r.relation === 'update')),
      first: set(
        qualified.filter(
          (r) => !r.peers.some((p) => p.qualified && p.first_seen_at < r.first_seen_at),
        ),
      ),
      selected: set(items.filter((r) => r.selected)),
      highlights: set(items.filter((r) => r.highlight)),
      title_only: items.filter((r) => r.material_kind === 'title').length,
      fetched: runs.rows.find((r) => r.source_id === source.id)?.fetched ?? 0,
      succeeded_runs: runs.rows.find((r) => r.source_id === source.id)?.succeeded_runs ?? 0,
      failed_runs: runs.rows.find((r) => r.source_id === source.id)?.failed_runs ?? 0,
      repeated_items: repetitions.rows.find((r) => r.source_id === source.id)?.repeated_items ?? 0,
      observed_items: repetitions.rows.find((r) => r.source_id === source.id)?.observed_items ?? 0,
      calls: calls.rows.find((r) => r.source_id === source.id)?.calls ?? 0,
    };
  });
  return { metrics, discoveries: rows, range };
}
export async function sourceMetrics() {
  return (await sourceQualityData()).metrics;
}
export async function sourceOverlap(days = 30) {
  const range = discoveryRange(undefined, days);
  const { rows } = await pool.query<{
    left_id: string;
    left_name: string;
    left_events: number;
    right_id: string;
    right_name: string;
    right_events: number;
    shared: number;
  }>(
    `WITH source_events AS (
      SELECT DISTINCT d.source_id,a.event_id FROM source_discoveries d
      JOIN articles a ON a.url=d.url
      WHERE d.first_seen_at>=$1 AND d.first_seen_at<$2 AND a.state='processed' AND a.event_id IS NOT NULL
    ), totals AS (
      SELECT source_id,count(*)::int total FROM source_events GROUP BY source_id
    ), common AS (
      SELECT a.source_id left_id,b.source_id right_id,count(*)::int shared
      FROM source_events a JOIN source_events b ON a.event_id=b.event_id AND a.source_id<b.source_id
      GROUP BY a.source_id,b.source_id HAVING count(*)>=3
    ) SELECT a.id left_id,a.name left_name,ta.total left_events,
      b.id right_id,b.name right_name,tb.total right_events,c.shared
    FROM common c JOIN sources a ON a.id=c.left_id JOIN sources b ON b.id=c.right_id
    JOIN totals ta ON ta.source_id=c.left_id JOIN totals tb ON tb.source_id=c.right_id
    ORDER BY c.shared DESC,least(c.shared::numeric/ta.total,c.shared::numeric/tb.total) DESC,a.name,b.name
    LIMIT 3`,
    [range.start, range.end],
  );
  return rows;
}
export async function sourceDayRuns(sourceId: string, date: string) {
  const { start, end } = discoveryRange(date);
  const { rows } = await pool.query<{
    id: string;
    started_at: Date;
    state: string;
    error: string | null;
    result: unknown;
    items: { title: string; url: string | null; outcome: string }[];
  }>(
    `SELECT r.*,
    coalesce((SELECT jsonb_agg(jsonb_build_object('title',i.title,'url',i.url,'outcome',i.outcome) ORDER BY i.id) FROM collection_items i WHERE i.run_id=r.id),'[]'::jsonb) items
    FROM collection_runs r WHERE source_id=$1 AND started_at >= $2 AND started_at<$3 ORDER BY started_at DESC`,
    [sourceId, start, end],
  );
  return rows;
}
