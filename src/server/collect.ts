import { rankingKind, rankingSnapshotUrl, compareRankingItem } from './ranking-sources.ts';
import { localDate } from './periods.ts';
import { loadWebItems } from './web-sources.ts';
import {
  officialListItems,
  readSourceDetail,
  UnsupportedSourceContentError,
} from './source-details.ts';
import { observeSourceItem, recordCollectionItem } from './source-observations.ts';
import { pool } from './db.ts';
import { getSettings } from './settings.ts';
import { nextInterval } from './source-rhythm.ts';
import { financeKind, financeItems } from './finance-sources.ts';
import Parser from 'rss-parser';
import { parseHtmlItems, validateHtmlSourceUrl } from './html-source.ts';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from './db.ts';
import { articles, sources } from './schema.ts';
import { fetchSource, SourceHttpError, type SourceFetchOptions } from './fetch.ts';
import { parseAihotItems, validateAihotUrl, isAihotItemsUrl } from './aihot.ts';
import { structuredItems, structuredKind } from './structured-sources.ts';
import { provenanceSchema, type Provenance } from './types.ts';
import { readWechatSourceDetail, wechatSourceItems } from './wechat.ts';
export const articleInput = z.object({
  title: z.string().trim().min(1).max(500),
  url: z
    .url()
    .max(2000)
    .refine((v) => /^https?:/.test(v)),
  excerpt: z.string().trim().min(1).max(16000),
  publishedAt: z.iso.datetime({ offset: true }),
  sourceName: z.string().trim().min(1).max(200),
  industryId: z.string().default('ai'),
  provenance: provenanceSchema.optional(),
  publishedPrecision: z.enum(['day', 'time', 'observed']).default('time'),
});
export function cleanText(text: string) {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
export async function parseRssItems(
  text: string,
  onInvalid?: (item: { title: string; url?: string }) => void,
) {
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
    const rawDate = (
      item.rawPubDate ??
      item.rawPublished ??
      item.rawUpdated ??
      item.rawDate
    )?.trim();
    if (!item.title || !item.link || !rawDate) {
      onInvalid?.({ title: item.title ? cleanText(item.title) : '无标题条目', url: item.link });
      return [];
    }
    // 未标注时区的来源时间统一按北京时间解释，与服务器所在时区无关。
    const date = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(rawDate)
      ? `${rawDate.length === 10 ? `${rawDate}T00:00:00` : rawDate.replace(' ', 'T')}+08:00`
      : /(?:Z|[+-]\d{2}:?\d{2}|[A-Z]{2,5})(?:\s*\([^)]*\))?$/i.test(rawDate)
        ? rawDate
        : `${rawDate} GMT+0800`;
    if (Number.isNaN(Date.parse(date))) {
      onInvalid?.({ title: cleanText(item.title), url: item.link });
      return [];
    }
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
  const value = { ...articleInput.parse(input), industryId: 'ai' };
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
async function collectEndpoint(
  id: string,
  fetcher: (url: string, options?: SourceFetchOptions) => Promise<string | null> = fetchSource,
  now = new Date(),
  options: { manual?: boolean } = {},
  endpoint?: string,
) {
  const config = await getSettings();
  if (!config.collectionEnabled && !options.manual) throw new Error('采集尚未开启');
  const [stored] = await db.select().from(sources).where(eq(sources.id, id));
  const source = stored && {
    ...stored,
    url: endpoint ?? stored.url,
    etag:
      stored.additionalUrls.length || stored.readDetails || (stored.url && rankingKind(stored.url))
        ? null
        : stored.etag,
  };
  if (!source?.enabled) throw new Error('信源已停用或不存在');
  if (source.format !== 'wechat' && (!source.url || source.format === 'manual'))
    throw new Error('信源尚无可用采集入口');
  const {
    rows: [run],
  } = await pool.query(
    'INSERT INTO collection_runs(source_id,source_name,url) VALUES($1,$2,$3) RETURNING id',
    [id, source.name, source.url ?? `wechat://${id}`],
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
    if (source.format === 'html' && rankingKind(source.url!)) {
      const snapshotUrl = rankingSnapshotUrl(source.url!, now);
      const {
        rows: [existing],
      } = await pool.query('SELECT title,url,published_at FROM articles WHERE url=$1', [
        snapshotUrl,
      ]);
      if (existing) {
        const item = {
          title: existing.title,
          url: existing.url,
          publishedAt: existing.published_at,
        };
        await observeSourceItem(id, item, now);
        await recordCollectionItem(run.id, id, item, 'repeated', now);
        await db
          .update(sources)
          .set({ lastFetchedAt: new Date(), lastError: null })
          .where(eq(sources.id, id));
        await success(0, {
          fetched: 1,
          inserted: 0,
          unchanged: true,
          snapshotDate: localDate(now),
          urls: [snapshotUrl],
        });
        return { fetched: 1, inserted: 0, unchanged: true };
      }
    }
    const aihot = source.format === 'json' && isAihotItemsUrl(source.url!);
    if (aihot) validateAihotUrl(source.url!);
    if (source.format === 'html') validateHtmlSourceUrl(source.url!);
    let etag: string | null = source.etag;
    const text =
      source.format === 'wechat'
        ? null
        : await fetcher(source.url!, {
            etag: source.etag,
            structuredContext: { now, dailyTime: config.dailyTime },
            onHeaders: (headers) => {
              etag = headers.etag;
            },
          });
    const nextFetchAt = new Date(Date.now() + source.intervalMinutes * 60_000);
    if (source.format !== 'wechat' && text === null) {
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
      publishedPrecision?: 'day' | 'time' | 'observed';
      contentComplete?: boolean;
    }[];
    const rejected: { title: string; url?: string }[] = [];
    const rss = (text: string) =>
      parseRssItems(text, (item) => {
        rejected.push(item);
      });
    const discarded: {
      item: { title: string; url: string; publishedAt: string };
      outcome: 'invalid' | 'outside_window';
    }[] = [];
    const listingUrls = new Set<string>();
    if (source.format === 'wechat') {
      items = await wechatSourceItems(id);
    } else if (financeKind(source.url!)) {
      items = await financeItems(source.url!, text!, {
        fetcher,
        clean: cleanText,
        rss,
        now,
        onDiscard: (item, outcome) => {
          discarded.push({ item, outcome });
        },
        exists: async (url) => {
          listingUrls.add(canonicalUrl(url));
          const [existing] = await db
            .select()
            .from(articles)
            .where(eq(articles.url, canonicalUrl(url)))
            .limit(1);
          if (existing) {
            const item = {
              title: existing.title,
              url: canonicalUrl(url),
              publishedAt: existing.publishedAt,
            };
            const within =
              existing.publishedAt.getTime() >= now.getTime() - 7 * 86400_000 &&
              existing.publishedAt <= now;
            const first = within ? await observeSourceItem(id, item, now) : false;
            await recordCollectionItem(
              run.id,
              id,
              item,
              within ? (first ? 'known' : 'repeated') : 'outside_window',
              now,
            );
          }
          return Boolean(existing);
        },
      });
    } else if (aihot) {
      items = parseAihotItems(text!);
    } else if (source.format === 'html') {
      items =
        officialListItems(text!, source.url!, now) ??
        (await loadWebItems(text!, source.url!, fetcher, now)) ??
        parseHtmlItems(text!, source.url!, cleanText, now);
    } else if (structuredKind(source.url!)) {
      items = structuredItems(source.url!, text!);
    } else if (source.format === 'rss') {
      items = await rss(text!);
    } else {
      const raw: unknown = JSON.parse(text!);
      if (!Array.isArray(raw) || raw.length > 100) throw new Error('信源条目须为不超过100条的数组');
      items = [];
      for (const entry of raw) {
        const parsed = articleInput.omit({ sourceName: true, industryId: true }).safeParse(entry);
        if (parsed.success) items.push(parsed.data);
        else
          await recordCollectionItem(
            run.id,
            id,
            {
              title: typeof entry?.title === 'string' ? entry.title : '无标题条目',
              url: typeof entry?.url === 'string' ? entry.url : null,
            },
            'invalid',
            now,
          );
      }
    }
    for (const entry of discarded)
      await recordCollectionItem(run.id, id, entry.item, entry.outcome, now);
    for (const item of rejected) await recordCollectionItem(run.id, id, item, 'invalid', now);
    // Record discarded items separately; this window never controls stored article retention.
    items = await Promise.all(
      items.map((item) => (item.provenance?.snapshot ? compareRankingItem(id, item) : item)),
    );
    const eligible: typeof items = [];
    for (const item of items) {
      const parsed = articleInput.safeParse({
        ...item,
        sourceName: item.sourceName ?? source.name,
      });
      if (!parsed.success) {
        await recordCollectionItem(run.id, id, item, 'invalid', now);
        continue;
      }
      const published = new Date(item.publishedAt).getTime();
      if (published < now.getTime() - 7 * 86400_000 || published > now.getTime()) {
        await recordCollectionItem(run.id, id, item, 'outside_window', now);
        continue;
      }
      eligible.push({ ...item, url: canonicalUrl(item.url) });
    }
    items = eligible;
    // 用信源自身列表的新增判断节奏，避免跨信源去重影响更新频率。
    const previous = await pool.query(
      "SELECT result->'urls' AS urls FROM collection_runs WHERE source_id=$1 AND state='succeeded' AND result ? 'urls' ORDER BY finished_at DESC LIMIT 1",
      [id],
    );
    const previousUrls = new Set<string>(previous.rows[0]?.urls ?? []);
    const urls = [...new Set([...listingUrls, ...items.map((item) => canonicalUrl(item.url))])];
    const sourceNew = urls.filter((url) => !previousUrls.has(url)).length;
    let inserted = 0;
    const detailErrors: string[] = [];
    for (const item of items) {
      const exists = await db
        .select({ id: articles.id })
        .from(articles)
        .where(eq(articles.url, canonicalUrl(item.url)))
        .limit(1);
      const first = await observeSourceItem(id, item, now);
      if (exists.length) {
        await recordCollectionItem(run.id, id, item, first ? 'known' : 'repeated', now);
        continue;
      }
      if (source.readDetails && !item.contentComplete) {
        try {
          Object.assign(
            item,
            source.format === 'wechat'
              ? await readWechatSourceDetail(item.url)
              : await readSourceDetail(item.url, fetcher),
          );
        } catch (error) {
          if (error instanceof UnsupportedSourceContentError) {
            await recordCollectionItem(run.id, id, item, 'invalid', now);
            continue;
          }
          await recordCollectionItem(run.id, id, item, 'failed', now);
          detailErrors.push(
            `${item.title}：${error instanceof Error ? error.message : '详情读取失败'}`,
          );
          continue;
        }
      }
      if (
        !source.readDetails &&
        source.url &&
        !['www.pbc.gov.cn', 'www.cac.gov.cn', 'www.nfra.gov.cn'].includes(
          new URL(source.url).hostname,
        ) &&
        item.excerpt === item.title &&
        !item.provenance
      ) {
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
      let saved: number;
      try {
        saved = (
          await importArticle(
            { ...item, industryId: 'ai', sourceName: item.sourceName ?? source.name },
            source.id,
          )
        ).length;
      } catch (error) {
        await recordCollectionItem(run.id, id, item, 'failed', now);
        throw error;
      }
      inserted += saved;
      if (saved)
        await pool.query(
          'UPDATE source_discoveries SET inserted=true WHERE source_id=$1 AND url=$2',
          [id, item.url],
        );
      await observeSourceItem(id, item, now);
      await recordCollectionItem(
        run.id,
        id,
        item,
        saved ? 'new' : first ? 'known' : 'repeated',
        now,
      );
    }
    await db
      .update(sources)
      .set({ lastFetchedAt: new Date(), lastError: null, etag, nextFetchAt })
      .where(eq(sources.id, id));
    if (detailErrors.length) throw new Error(detailErrors.join('；').slice(0, 1000));
    await success(sourceNew, { fetched: items.length, inserted, sourceNew, urls });
    return { fetched: items.length, inserted };
  } catch (error) {
    const rhythm = nextInterval(source, { failed: true });
    const snapshotRetry = source.format === 'html' && rankingKind(source.url!);
    const retryMinutes = snapshotRetry ? 60 : rhythm.interval;
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
        intervalReason: snapshotRetry ? '榜单快照采集失败，60分钟后重试' : rhythm.reason,
        nextFetchAt:
          error instanceof SourceHttpError && error.retryAt
            ? new Date(Math.max(error.retryAt.getTime(), Date.now() + retryMinutes * 60_000))
            : new Date(Date.now() + retryMinutes * 60_000),
        lastError: error instanceof Error ? error.message.slice(0, 300) : '采集失败',
      })
      .where(eq(sources.id, id));
    throw error;
  }
}

export async function collectSource(
  id: string,
  fetcher = fetchSource,
  now = new Date(),
  options: { manual?: boolean } = {},
) {
  const [source] = await db.select().from(sources).where(eq(sources.id, id));
  if (!source?.additionalUrls.length) return collectEndpoint(id, fetcher, now, options);
  let fetched = 0,
    inserted = 0;
  const errors: string[] = [];
  for (const endpoint of [source.url!, ...source.additionalUrls]) {
    try {
      const result = await collectEndpoint(id, fetcher, now, options, endpoint);
      fetched += result.fetched;
      inserted += result.inserted;
    } catch (e) {
      errors.push(`${endpoint}：${e instanceof Error ? e.message : '采集失败'}`);
    }
  }
  if (errors.length) {
    await pool.query(
      'UPDATE sources SET last_error=$2,failure_count=greatest(failure_count,1) WHERE id=$1',
      [id, errors.join('；').slice(0, 1000)],
    );
    throw new Error(errors.join('；'));
  }
  return { fetched, inserted };
}
