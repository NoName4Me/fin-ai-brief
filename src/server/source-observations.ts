import { pool } from './db.ts';
export type CollectionOutcome =
  'new' | 'known' | 'repeated' | 'outside_window' | 'invalid' | 'failed';
export async function recordCollectionItem(
  runId: string,
  sourceId: string,
  item: {
    title: string;
    url?: string | null;
    publishedAt?: string | Date | null;
  },
  outcome: CollectionOutcome,
  observedAt: Date,
) {
  await pool.query(
    `INSERT INTO collection_items(run_id,source_id,title,url,published_at,outcome,observed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      runId,
      sourceId,
      item.title.slice(0, 500),
      item.url ?? null,
      item.publishedAt && Number.isFinite(new Date(item.publishedAt).getTime())
        ? item.publishedAt
        : null,
      outcome,
      observedAt,
    ],
  );
}
export async function observeSourceItem(
  sourceId: string,
  item: {
    url: string;
    title: string;
    publishedAt: string | Date;
    excerpt?: string;
  },
  now: Date,
) {
  const material = !item.excerpt ? 'unknown' : item.excerpt === item.title ? 'title' : 'summary';
  const { rows } = await pool.query<{ first: boolean }>(
    `INSERT INTO source_discoveries(source_id,url,title,published_at,first_seen_at,last_seen_at,material_kind)
    VALUES($1,$2,$3,$4,$5,$5,$6) ON CONFLICT(source_id,url) DO UPDATE SET
    title=excluded.title,published_at=excluded.published_at,last_seen_at=greatest(source_discoveries.last_seen_at,excluded.last_seen_at),
    material_kind=CASE WHEN excluded.material_kind='unknown' THEN source_discoveries.material_kind ELSE excluded.material_kind END
    RETURNING (xmax=0) AS first`,
    [sourceId, item.url, item.title, item.publishedAt, now, material],
  );
  return rows[0].first;
}
