import { pool } from './db.ts';
import { getSettings } from './settings.ts';
import { nextInterval } from './source-rhythm.ts';
import { financeKind, financeItems } from './finance-sources.ts';
import { isJiqizhixinRss, validateSourceAccess } from './source-access.ts';
import Parser from 'rss-parser';
import { parseHtmlItems, validateHtmlSourceUrl } from './html-source.ts';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from './db.ts';
import { articles, sources } from './schema.ts';
import { fetchSource, SourceHttpError, type SourceFetchOptions } from './fetch.ts';
import { parseAihotItems, validateAihotUrl, isAihotItemsUrl } from './aihot.ts';
import { provenanceSchema, type Provenance } from './types.ts';
export const articleInput = z.object({
  title: z.string().trim().min(1).max(500),
  url: z
    .url()
    .max(2000)
    .refine((v) => /^https?:/.test(v)),
  excerpt: z.string().trim().min(1).max(16000),
  publishedAt: z.iso.datetime({ offset: true }),
  sourceName: z.string().trim().min(1).max(200),
  industryId: z.string().min(1).max(80),
  provenance: provenanceSchema.optional(),
  publishedPrecision: z.enum(['day', 'time']).default('time'),
});
export function cleanText(text: string) {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
export async function parseRssItems(text: string) {
  const feed = await new Parser<
    unknown,
    { rawPubDate?: string; rawPublished?: string; rawUpdated?: string; rawDate?: string }
  >({
    customFields: {
      item: [
        ['pubDate', 'rawPubDate'],
        ['published', 'rawPublished'],
        ['updated', 'rawUpdated'],
        ['dc:date', 'rawDate'],
      ],
    },
  }).parseString(text);
  return feed.items.slice(0, 100).flatMap((item) => {
    const date = item.rawPubDate ?? item.rawPublished ?? item.rawUpdated ?? item.rawDate;
    if (
      !item.title ||
      !item.link ||
      !date ||
      !/(Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/i.test(date) ||
      Number.isNaN(Date.parse(date))
    )
      return [];
    return [
      {
        title: cleanText(item.title).slice(0, 500),
        url: item.link,
        excerpt:
          cleanText(item.contentSnippet ?? item.content ?? '').slice(0, 16000) ||
          cleanText(item.title).slice(0, 500),
        publishedAt: new Date(date).toISOString(),
      },
    ];
  });
}
export function pageDescription(html: string) {
  let description = '';
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = Object.fromEntries(
      [...tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [
        m[1].toLowerCase(),
        m[2] ?? m[3],
      ]),
    );
    const key = attributes.property ?? attributes.name;
    if (key === 'og:description') return cleanText(attributes.content ?? '').slice(0, 16000);
    if (key === 'description') description = cleanText(attributes.content ?? '').slice(0, 16000);
  }
  return description;
}
export function canonicalUrl(input: string) {
  const url = new URL(input);
  url.hash = '';
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_|fbclid|gclid)/.test(key)) url.searchParams.delete(key);
  return url.href;
}
export async function importArticle(input: unknown, sourceId?: string) {
  const value = articleInput.parse(input);
  return db
    .insert(articles)
    .values({
      ...value,
      url: canonicalUrl(value.url),
      publishedAt: new Date(value.publishedAt),
      sourceId,
    })
    .onConflictDoNothing({ target: articles.url })
    .returning({ id: articles.id });
}
export async function collectSource(
  id: string,
  fetcher: (url: string, options?: SourceFetchOptions) => Promise<string | null> = fetchSource,
  now = new Date(),
  options: { manual?: boolean } = {},
) {
  if (!(await getSettings()).collectionEnabled && !options.manual) throw new Error('采集尚未开启');
  const [source] = await db.select().from(sources).where(eq(sources.id, id));
  if (!source?.enabled) throw new Error('信源已停用或不存在');
  validateSourceAccess(source);
  if (
    isJiqizhixinRss(source.url) &&
    source.lastFetchedAt &&
    now.getTime() - source.lastFetchedAt.getTime() < 60 * 60_000
  )
    throw new Error('机器之心每60分钟最多请求一次，请稍后再采集');
  const {
    rows: [run],
  } = await pool.query(
    'INSERT INTO collection_runs(source_id,source_name,url) VALUES($1,$2,$3) RETURNING id',
    [id, source.name, source.url],
  );
  async function success(inserted: number, result: unknown) {
    const rhythm = nextInterval(source, { inserted });
    await db
      .update(sources)
      .set({
        intervalMinutes: rhythm.interval,
        quietRuns: rhythm.quiet,
        failureCount: 0,
        stableRuns: rhythm.stable,
        intervalReason: rhythm.reason,
        nextFetchAt: new Date(Date.now() + rhythm.interval * 60_000),
      })
      .where(eq(sources.id, id));
    await pool.query(
      "UPDATE collection_runs SET state='succeeded',finished_at=now(),result=$2 WHERE id=$1",
      [run.id, JSON.stringify(result)],
    );
  }
  try {
    const aihot = source.format === 'json' && isAihotItemsUrl(source.url);
    if (aihot) validateAihotUrl(source.url);
    if (source.format === 'html') validateHtmlSourceUrl(source.url);
    let etag: string | null = source.etag;
    const text = await fetcher(source.url, {
      etag: source.etag,
      onHeaders: (headers) => {
        etag = headers.etag;
      },
    });
    const nextFetchAt = new Date(Date.now() + source.intervalMinutes * 60_000);
    if (text === null) {
      await db
        .update(sources)
        .set({ lastFetchedAt: new Date(), lastError: null, nextFetchAt })
        .where(eq(sources.id, id));
      await success(0, { fetched: 0, inserted: 0, unchanged: true });
      return { fetched: 0, inserted: 0, unchanged: true };
    }
    let items: {
      title: string;
      url: string;
      excerpt: string;
      publishedAt: string;
      sourceName?: string;
      provenance?: Provenance;
      publishedPrecision?: 'day' | 'time';
    }[];
    const listingUrls = new Set<string>();
    if (financeKind(source.url)) {
      items = await financeItems(source.url, text, {
        fetcher,
        clean: cleanText,
        rss: parseRssItems,
        now,
        exists: async (url) => {
          listingUrls.add(canonicalUrl(url));
          return Boolean(
            (
              await db
                .select({ id: articles.id })
                .from(articles)
                .where(eq(articles.url, canonicalUrl(url)))
                .limit(1)
            ).length,
          );
        },
      });
    } else if (aihot) {
      items = parseAihotItems(text);
    } else if (source.format === 'html') {
      items = parseHtmlItems(text, source.url, cleanText);
    } else if (source.format === 'rss') {
      items = await parseRssItems(text);
    } else {
      items = z
        .array(articleInput.omit({ sourceName: true, industryId: true }))
        .max(100)
        .parse(JSON.parse(text));
    }
    // 上游订阅可能携带多年存档；常规采集只读取最近7天，避免首次接入灌入历史数据。
    items = items.filter(
      (item) =>
        new Date(item.publishedAt).getTime() >= now.getTime() - 7 * 86400_000 &&
        new Date(item.publishedAt).getTime() <= now.getTime(),
    );
    // 用信源自身列表的新增判断节奏，避免跨信源去重影响更新频率。
    const previous = await pool.query(
      "SELECT result->'urls' AS urls FROM collection_runs WHERE source_id=$1 AND state='succeeded' AND result ? 'urls' ORDER BY finished_at DESC LIMIT 1",
      [id],
    );
    const previousUrls = new Set<string>(previous.rows[0]?.urls ?? []);
    const urls = [...new Set([...listingUrls, ...items.map((item) => canonicalUrl(item.url))])];
    const sourceNew = urls.filter((url) => !previousUrls.has(url)).length;
    let inserted = 0;
    for (const item of items) {
      const exists = await db
        .select({ id: articles.id })
        .from(articles)
        .where(eq(articles.url, canonicalUrl(item.url)))
        .limit(1);
      if (exists.length) continue;
      if (item.excerpt === item.title && !item.provenance && !isJiqizhixinRss(source.url)) {
        try {
          const html = await fetcher(item.url);
          if (html) item.excerpt = pageDescription(html) || item.title;
        } catch (error) {
          // 简介是额外材料，原页不可读时只保留订阅中实际提供的标题。
          console.warn(
            '信源条目简介读取失败：',
            item.url,
            error instanceof Error ? error.message : '读取失败',
          );
        }
      }
      inserted += (
        await importArticle(
          { ...item, industryId: source.industryId, sourceName: item.sourceName ?? source.name },
          source.id,
        )
      ).length;
    }
    await db
      .update(sources)
      .set({ lastFetchedAt: new Date(), lastError: null, etag, nextFetchAt })
      .where(eq(sources.id, id));
    await success(sourceNew, { fetched: items.length, inserted, sourceNew, urls });
    return { fetched: items.length, inserted };
  } catch (error) {
    const rhythm = nextInterval(source, { failed: true });
    await pool.query(
      "UPDATE collection_runs SET state='failed',finished_at=now(),error=$2 WHERE id=$1",
      [run.id, error instanceof Error ? error.message.slice(0, 1000) : '采集失败'],
    );
    await db
      .update(sources)
      .set({
        lastFetchedAt: new Date(),
        intervalMinutes: source.autoInterval ? rhythm.interval : source.intervalMinutes,
        quietRuns: rhythm.quiet,
        failureCount: rhythm.failures,
        stableRuns: rhythm.stable,
        intervalReason: rhythm.reason,
        nextFetchAt:
          error instanceof SourceHttpError && error.retryAt
            ? new Date(Math.max(error.retryAt.getTime(), Date.now() + rhythm.interval * 60_000))
            : new Date(Date.now() + rhythm.interval * 60_000),
        lastError: error instanceof Error ? error.message.slice(0, 300) : '采集失败',
      })
      .where(eq(sources.id, id));
    throw error;
  }
}
