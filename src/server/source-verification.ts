import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db.ts';
import { sources } from './schema.ts';
import { fetchSource } from './fetch.ts';
import { cleanText, parseRssItems, articleInput } from './collect.ts';
import { isJiqizhixinRss } from './source-access.ts';
import { financeItems, financeKind } from './finance-sources.ts';
import { parseHtmlItems } from './html-source.ts';
import { isAihotItemsUrl, parseAihotItems } from './aihot.ts';
import { structuredItems, structuredKind } from './structured-sources.ts';

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
    if (
      isJiqizhixinRss(endpoint) &&
      Math.max(source.lastFetchedAt?.getTime() ?? 0, source.verifiedAt?.getTime() ?? 0) >
        Date.now() - 3600000
    )
      throw new Error('机器之心每60分钟最多请求一次，请稍后再验证');
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
      const body = await fetcher(endpoint);
      if (!body) throw new Error('未取得可验证的内容');
      const items = structuredKind(endpoint)
        ? structuredItems(endpoint, body)
        : financeKind(endpoint)
          ? await financeItems(endpoint, body, {
              fetcher,
              clean: cleanText,
              rss: parseRssItems,
              now: new Date(),
              exists: async () => false,
            })
          : format === 'rss'
            ? await parseRssItems(body)
            : format === 'html'
              ? parseHtmlItems(body, endpoint, cleanText)
              : isAihotItemsUrl(endpoint)
                ? parseAihotItems(body)
                : z
                    .array(articleInput.omit({ sourceName: true, industryId: true }))
                    .max(100)
                    .parse(JSON.parse(body));
      const valid = items.filter(
        (item) => articleInput.omit({ sourceName: true, industryId: true }).safeParse(item).success,
      );
      if (!valid.length) throw new Error('未解析到含标题、原文链接和明确发布时间的有效条目');
      status =
        source.verificationStatus === 'approved' && endpoint === source.url
          ? 'approved'
          : 'technical';
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
      const thin = withSummary < valid.length / 2;
      if (stale || thin) status = 'held';
      note = `解析${valid.length}条；最新发布时间${valid
        .map((v) => v.publishedAt)
        .sort()
        .at(
          -1,
        )}；有效摘要${withSummary}条。${stale ? '条目已超过90天，暂不选用此入口。' : thin ? '有效摘要不足，待补齐采集内容后再选用。' : '技术验证不代表内容评估通过。'}\n${valid
        .slice(0, 5)
        .map((v) => `${v.title}\n${v.excerpt.slice(0, 120)}\n${v.url}`)
        .join('\n')}`;
    }
  } catch (error) {
    status = 'failed';
    note = error instanceof Error ? error.message : '验证请求失败';
    if (note.includes('每60分钟')) throw error;
    if (source.verificationNote) note += `\n上次记录：${source.verificationNote.slice(0, 1500)}`;
  }
  // Do not overwrite a configuration edited while the request was in flight.
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(sources).where(eq(sources.id, id)).for('update');
    if (
      !current ||
      current.url !== source.url ||
      current.format !== source.format ||
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
