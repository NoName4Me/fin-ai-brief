import { loadWebItems } from './web-sources.ts';
import {
  officialListItems,
  readSourceDetail,
  UnsupportedSourceContentError,
} from './source-details.ts';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, pool } from './db.ts';
import { sources } from './schema.ts';
import { fetchSource } from './fetch.ts';
import { cleanText, parseRssItems, articleInput } from './collect.ts';
import { financeItems, financeKind } from './finance-sources.ts';
import { parseHtmlItems } from './html-source.ts';
import { isAihotItemsUrl, parseAihotItems } from './aihot.ts';
import { structuredItems, structuredKind } from './structured-sources.ts';
import { getSettings } from './settings.ts';

export function advertisedFeeds(html: string, base: string) {
  return [...html.matchAll(/<link\b[^>]*>/gi)]
    .flatMap(([tag]) => {
      const attrs = Object.fromEntries(
        [...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map((m) => [
          m[1].toLowerCase(),
          m[2],
        ]),
      );
      if (
        !/\balternate\b/i.test(attrs.rel ?? '') ||
        !/(?:rss|atom)\+xml/i.test(attrs.type ?? '') ||
        !attrs.href
      )
        return [];
      try {
        const url = new URL(attrs.href.replace(/&amp;/g, '&'), base);
        return /^https?:$/.test(url.protocol) ? [url.href] : [];
      } catch {
        return [];
      }
    })
    .slice(0, 3);
}
// Verification never imports articles, calls a model, or enables a source.
export async function verifySource(id: string, fetcher = fetchSource) {
  const [source] = await db
    .select()
    .from(sources)
    .where(eq(sources.id, z.uuid().parse(id)));
  if (!source) throw new Error('信源不存在');
  let endpoint = source.url;
  let format = source.format;
  let status = source.verificationStatus;
  let note = '';
  try {
    const config = await getSettings();
    if (!endpoint || format === 'manual') {
      if (!/^https?:\/\//i.test(source.originAddress)) {
        status = 'pending';
        note = '账号或订阅型来源，尚无可验证的公开采集入口';
      } else {
        const html = await fetcher(source.originAddress);
        const feeds = advertisedFeeds(html ?? '', source.originAddress);
        if (feeds.length) {
          endpoint = feeds[0];
          format = 'rss';
        } else {
          status = 'pending';
          note = '已检查来源页面，未发现公开声明的RSS；待适配入口或订阅渠道';
        }
      }
    }
    if (endpoint && format !== 'manual') {
      const samples = [];
      let imageOnly = 0,
        detailSuccess = 0;
      for (const entry of [endpoint, ...source.additionalUrls]) {
        const body = await fetcher(entry, {
          structuredContext: { now: new Date(), dailyTime: config.dailyTime },
        });
        if (!body) throw new Error('未取得可验证的内容');
        const items = structuredKind(entry)
          ? structuredItems(entry, body)
          : financeKind(entry)
            ? await financeItems(entry, body, {
                fetcher,
                clean: cleanText,
                rss: parseRssItems,
                now: new Date(),
                exists: async () => false,
              })
            : format === 'rss'
              ? await parseRssItems(body)
              : format === 'html'
                ? (officialListItems(body, entry) ??
                  (await loadWebItems(body, entry, fetcher)) ??
                  parseHtmlItems(body, entry, cleanText))
                : isAihotItemsUrl(entry)
                  ? parseAihotItems(body)
                  : z
                      .array(articleInput.omit({ sourceName: true, industryId: true }))
                      .max(100)
                      .parse(JSON.parse(body));
        if (source.readDetails) {
          for (const item of items
            .filter(
              (v: { publishedAt: string }) =>
                Date.parse(v.publishedAt) >= Date.now() - 7 * 86400000 &&
                Date.parse(v.publishedAt) <= Date.now(),
            )
            .slice(0, 3)) {
            if ('contentComplete' in item && item.contentComplete) {
              detailSuccess++;
              continue;
            }
            const existing = await pool.query('SELECT 1 FROM articles WHERE url=$1', [item.url]);
            if (!existing.rowCount) {
              try {
                Object.assign(item, await readSourceDetail(item.url, fetcher));
                detailSuccess++;
              } catch (error) {
                if (!(error instanceof UnsupportedSourceContentError)) throw error;
                imageOnly++;
              }
            }
          }
        }
        if (!items.length) throw new Error('采集入口未解析到资讯');
        samples.push(...items);
      }
      if (imageOnly && !detailSuccess) throw new Error('抽查详情页仅含图片，没有可读取的文字正文');
      const valid = samples.filter(
        (item) => articleInput.omit({ sourceName: true, industryId: true }).safeParse(item).success,
      );
      if (!valid.length) throw new Error('未解析到含标题、原文链接和明确发布时间的有效条目');
      status = 'approved';
      const latest = Math.max(...valid.map((v) => Date.parse(v.publishedAt)));
      const withSummary = valid.filter((v) => {
        const summary = v.excerpt.trim();
        return (
          summary.length >= 8 &&
          summary !== v.title.trim() &&
          !/^(?:点击查看原文|查看原文|阅读原文|read more|continue reading)[>\s.。…]*$/i.test(
            summary,
          )
        );
      }).length;
      const stale = latest < Date.now() - 90 * 86400000;
      const thin = !source.readDetails && withSummary < valid.length / 2;
      note = `${imageOnly ? `跳过${imageOnly}条纯图片资讯；` : ''}解析${valid.length}条；最新发布时间${valid
        .map((v) => v.publishedAt)
        .sort()
        .at(
          -1,
        )}；有效摘要${withSummary}条。${stale ? '条目已超过90天，时效性需人工核查。' : thin ? '有效摘要不足，建议补齐正文读取。' : '采集验证通过。'}\n${valid
        .slice(0, 5)
        .map((v) => `${v.title}\n${v.excerpt.slice(0, 120)}\n${v.url}`)
        .join('\n')}`;
    }
  } catch (error) {
    status = 'failed';
    note = error instanceof Error ? error.message : '验证请求失败';
    if (source.verificationNote) note += `\n上次记录：${source.verificationNote.slice(0, 1500)}`;
  }
  // Do not overwrite a configuration edited while the request was in flight.
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(sources).where(eq(sources.id, id)).for('update');
    if (
      !current ||
      current.url !== source.url ||
      current.format !== source.format ||
      current.readDetails !== source.readDetails ||
      JSON.stringify(current.additionalUrls) !== JSON.stringify(source.additionalUrls) ||
      current.originAddress !== source.originAddress ||
      current.verificationStatus !== source.verificationStatus ||
      current.verificationNote !== source.verificationNote
    )
      throw new Error('验证期间信源配置已更改，请重新验证');
    await tx
      .update(sources)
      .set({
        url: endpoint,
        format,
        verificationStatus: status,
        verificationNote: note.slice(0, 2000),
        verifiedAt: new Date(),
      })
      .where(eq(sources.id, id));
  });
  return { status, note };
}
