import { and, desc, eq, gte, isNotNull, inArray, sql } from 'drizzle-orm';
import { db, pool } from './db.ts';
import { briefs, events, articles, industries } from './schema.ts';
import { cleanBriefTitle } from './brief-title.ts';
import { getSettings } from './settings.ts';
import type { Kind } from './types.ts';
// 所有读者页面与邮件只从这里取得正式内容。
export async function listPublished(kind?: Kind) {
  const rows = await db
    .select({
      id: briefs.id,
      kind: briefs.kind,
      periodDate: briefs.periodDate,
      issueNumber: briefs.issueNumber,
      content: briefs.published,
      publishedAt: briefs.publishedAt,
    })
    .from(briefs)
    .where(and(isNotNull(briefs.published), kind ? eq(briefs.kind, kind) : undefined))
    .orderBy(desc(briefs.periodDate));
  return rows.map((row) => ({
    ...row,
    content: row.content
      ? { ...row.content, title: cleanBriefTitle(row.content.title) }
      : row.content,
  }));
}
export async function publishedBrief(id: string) {
  const [row] = await db
    .select({
      id: briefs.id,
      kind: briefs.kind,
      periodDate: briefs.periodDate,
      issueNumber: briefs.issueNumber,
      content: briefs.published,
      publishedAt: briefs.publishedAt,
    })
    .from(briefs)
    .where(and(eq(briefs.id, id), isNotNull(briefs.published)));
  return row
    ? {
        ...row,
        content: row.content
          ? { ...row.content, title: cleanBriefTitle(row.content.title) }
          : row.content,
      }
    : row;
}
export async function publicIndustries() {
  return db.select().from(industries).orderBy(industries.position);
}
export async function latestNews(
  industryId?: string,
  q = '',
  before?: { time: string; id: string },
) {
  const config = await getSettings();
  const cutoff = config.retentionEnabled
    ? new Date(Date.now() - config.newsRetentionDays * 86_400_000)
    : undefined;
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        cutoff ? gte(events.occurredAt, cutoff) : undefined,
        industryId ? eq(events.industryId, industryId) : undefined,
        q ? sql`${events.title} ILIKE ${'%' + q + '%'}` : undefined,
        before
          ? sql`(${events.occurredAt},${events.id}) < (${before.time}::timestamptz,${before.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(events.occurredAt), desc(events.id))
    .limit(100);
  if (!rows.length) return [];
  const refs = await db
    .select({
      eventId: articles.eventId,
      url: articles.url,
      name: articles.sourceName,
      publishedAt: articles.publishedAt,
      publishedPrecision: articles.publishedPrecision,
      provenance: articles.provenance,
    })
    .from(articles)
    .where(
      sql`${articles.eventId} IN (${sql.join(
        rows.map((e) => sql`${e.id}::uuid`),
        sql`,`,
      )})`,
    );
  return rows.map((e) => ({
    ...e,
    sources: refs.filter((a) => a.eventId === e.id),
    timeKnown: refs.some(
      (a) =>
        a.eventId === e.id &&
        a.publishedPrecision === 'time' &&
        a.publishedAt.getTime() === e.occurredAt.getTime(),
    ),
  }));
}

export type NewsItem = Awaited<ReturnType<typeof latestNews>>[number];
export async function newsSnapshot(
  industry?: string,
  q = '',
  before?: { time: string; id: string },
) {
  const head = await pool.query('SELECT coalesce(max(id),0)::text cursor FROM news_changes');
  return { cursor: head.rows[0].cursor as string, items: await latestNews(industry, q, before) };
}
export async function newsChanges(since: string, industry?: string, q = '') {
  const config = await getSettings();
  const cutoff = config.retentionEnabled
    ? new Date(Date.now() - config.newsRetentionDays * 86_400_000)
    : undefined;
  const changes = await pool.query(
    `SELECT id::text,event_id FROM news_changes WHERE id>$1::bigint ORDER BY id LIMIT 200`,
    [since],
  );
  if (!changes.rows.length) return { cursor: since, items: [], changed: [] };
  const ids = [...new Set(changes.rows.map((r) => r.event_id as string))];
  // Read from the same public projection as the initial page. Old changed events outside its window
  // are fetched separately, so an update cannot silently disappear behind the first 100 results.
  const found = await db
    .select()
    .from(events)
    .where(
      and(
        inArray(events.id, ids),
        cutoff ? gte(events.occurredAt, cutoff) : undefined,
        industry ? eq(events.industryId, industry) : undefined,
        q ? sql`${events.title} ILIKE ${'%' + q + '%'}` : undefined,
      ),
    );
  const refs = await db
    .select({
      eventId: articles.eventId,
      url: articles.url,
      name: articles.sourceName,
      publishedAt: articles.publishedAt,
      publishedPrecision: articles.publishedPrecision,
      provenance: articles.provenance,
    })
    .from(articles)
    .where(inArray(articles.eventId, ids));
  return {
    cursor: changes.rows.at(-1)!.id as string,
    changed: ids,
    items: found.map((e) => ({
      ...e,
      sources: refs.filter((a) => a.eventId === e.id),
      timeKnown: refs.some(
        (a) =>
          a.eventId === e.id &&
          a.publishedPrecision === 'time' &&
          a.publishedAt.getTime() === e.occurredAt.getTime(),
      ),
    })),
  };
}
