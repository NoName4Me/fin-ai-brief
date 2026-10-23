import { z } from 'zod';
import { localDate } from './periods.ts';
import type { SourceFetchOptions } from './fetch.ts';
export const financeSources = [
  {
    name: '中国人民银行',
    url: 'https://www.pbc.gov.cn/goutongjiaoliu/113456/2986536/index.html',
    format: 'rss',
  },
  {
    name: '国家金融监督管理总局',
    url: 'https://www.nfra.gov.cn/cbircweb/DocInfo/SelectItemAndDocByItemUUId?pageSize=7&orderBy=item',
    format: 'json',
  },
  {
    name: '中国证监会',
    url: 'https://www.csrc.gov.cn/searchList/a1a078ee0bc54721ab6b148884c784a8?_isAgg=true&_isJson=true&_pageSize=30&_template=index&page=1',
    format: 'json',
  },
  { name: '上海证券报金融频道', url: 'https://www.cnstock.com/channel/10011', format: 'html' },
  { name: '中国银行保险报', url: 'https://rm-api.cfmc.cn/web/home/news', format: 'json' },
] as const;
export function financeKind(input: string) {
  const u = new URL(input);
  if (u.protocol !== 'https:') return null;
  if (u.hostname === 'www.pbc.gov.cn' && u.pathname === '/goutongjiaoliu/113456/2986536/index.html')
    return 'pbc';
  if (
    u.hostname === 'www.nfra.gov.cn' &&
    u.pathname === '/cbircweb/DocInfo/SelectItemAndDocByItemUUId'
  )
    return 'nfra';
  if (
    u.hostname === 'www.csrc.gov.cn' &&
    u.pathname === '/searchList/a1a078ee0bc54721ab6b148884c784a8'
  )
    return 'csrc';
  if (u.hostname === 'www.cnstock.com' && u.pathname === '/channel/10011') return 'cnstock';
  if (u.hostname === 'rm-api.cfmc.cn' && u.pathname === '/web/home/news') return 'cbimc';
  return null;
}
type Item = {
  title: string;
  url: string;
  excerpt: string;
  publishedAt: string;
  publishedPrecision?: 'day' | 'time';
  sourceName?: string;
};
type Context = {
  fetcher: (url: string, options?: SourceFetchOptions) => Promise<string | null>;
  clean: (value: string) => string;
  rss: (text: string) => Promise<Item[]>;
  exists: (url: string) => Promise<boolean>;
  now: Date;
};
const localTime = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) throw Error('信源时间格式已变化');
  return (s.length === 16 ? s + ':00' : s).replace(' ', 'T') + '+08:00';
};
const dayTime = (s: string) => `${s.slice(0, 10)}T00:00:00+08:00`;
function nextData(text: string) {
  const raw = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(
    text,
  )?.[1];
  if (!raw) throw Error('信源页面缺少结构化数据');
  return JSON.parse(raw).props.pageProps.data;
}
export async function financeItems(input: string, text: string, c: Context): Promise<Item[]> {
  const kind = financeKind(input);
  const result: Item[] = [];
  const recent = (date: string) => {
    const t = Date.parse(date);
    return Number.isFinite(t) && t <= c.now.getTime() && t >= c.now.getTime() - 7 * 86400000;
  };
  const excerpt = (html: string) => {
    const stripped = html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    const paragraphs = [...stripped.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((x) => c.clean(x[1]))
      .filter(Boolean);
    return c.clean(paragraphs.length ? paragraphs.join(' ') : stripped).slice(0, 1200);
  };
  const read = async (url: string, opts?: SourceFetchOptions) => {
    const body = await c.fetcher(url, opts);
    if (body === null) throw Error('信源详情返回空响应');
    return body;
  };
  if (kind === 'pbc') {
    for (const item of await c.rss(text)) {
      const url = item.url.startsWith('www.pbc.gov.cn/')
        ? 'https://' + item.url
        : new URL(item.url, input).href;
      if (new URL(url).origin !== 'https://www.pbc.gov.cn')
        throw Error('央行RSS原文地址不属于官方网站');
      if (!recent(item.publishedAt) || (await c.exists(url))) continue;
      const html = await read(url);
      const title = c.clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
      if (!title) throw Error('央行详情缺少完整标题');
      result.push({
        ...item,
        url,
        title,
        excerpt: excerpt(item.excerpt) || title,
        publishedAt: dayTime(localDate(new Date(item.publishedAt))),
        publishedPrecision: 'day',
      });
    }
  } else if (kind === 'nfra') {
    const body = z
      .object({
        rptCode: z.literal(200),
        data: z.array(
          z.object({
            itemId: z.number(),
            docInfoVOList: z.array(
              z.object({ docId: z.number(), docTitle: z.string(), publishDate: z.string() }),
            ),
          }),
        ),
      })
      .parse(JSON.parse(text));
    for (const group of body.data.filter((x) => [915, 917, 926, 951].includes(x.itemId)))
      for (const row of group.docInfoVOList) {
        const publishedAt = localTime(row.publishDate);
        const url = `https://www.nfra.gov.cn/cn/view/pages/ItemDetail.html?docId=${row.docId}&itemId=${group.itemId}`;
        if (!recent(publishedAt) || (await c.exists(url))) continue;
        const detail = z
          .object({ rptCode: z.literal(200), data: z.object({ docClob: z.string() }) })
          .parse(
            JSON.parse(
              await read(
                `https://www.nfra.gov.cn/cbircweb/DocInfo/SelectByDocId?docId=${row.docId}`,
              ),
            ),
          );
        result.push({
          title: c.clean(row.docTitle),
          url,
          publishedAt,
          excerpt: excerpt(detail.data.docClob) || c.clean(row.docTitle),
        });
      }
  } else if (kind === 'csrc') {
    const body = z
      .object({
        data: z.object({
          results: z.array(
            z.object({
              title: z.string(),
              url: z.string(),
              publishedTimeStr: z.string(),
              content: z.string(),
            }),
          ),
        }),
      })
      .parse(JSON.parse(text));
    for (const row of body.data.results) {
      localTime(row.publishedTimeStr);
      const publishedAt = dayTime(row.publishedTimeStr);
      const url = new URL(row.url, input).href;
      if (new URL(url).origin !== 'https://www.csrc.gov.cn')
        throw Error('证监会原文地址不属于官方网站');
      if (!recent(publishedAt) || (await c.exists(url))) continue;
      result.push({
        title: c.clean(row.title),
        url,
        publishedAt,
        publishedPrecision: 'day',
        excerpt: excerpt(row.content) || c.clean(row.title),
      });
    }
  } else if (kind === 'cnstock') {
    const cards = z
      .object({ pageInfo: z.object({ list: z.array(z.unknown()) }) })
      .parse(nextData(text)).pageInfo.list;
    const cardSchema: z.ZodType<{ contId?: string; forwardType?: number; childList?: unknown[] }> =
      z.object({
        contId: z.string().optional(),
        forwardType: z.number().optional(),
        childList: z.array(z.unknown()).optional(),
      });
    const flatten = (rows: unknown[]): { contId: string; forwardType: number }[] =>
      rows.flatMap((raw) => {
        const row = cardSchema.parse(raw);
        return row.childList
          ? flatten(row.childList)
          : row.contId && row.forwardType === 4
            ? [{ contId: row.contId, forwardType: 4 }]
            : [];
      });
    for (const id of [...new Set(flatten(cards).map((x) => x.contId))].slice(0, 50)) {
      if (!/^\d+$/.test(id)) throw Error('上证报文章标识格式已变化');
      const url = `https://www.cnstock.com/commonDetail/${id}`;
      if (await c.exists(url)) continue;
      const row = z
        .object({
          title: z.string(),
          pubTime: z.string(),
          source: z.string().optional(),
          textInfo: z.object({ content: z.string() }),
        })
        .parse(
          z.object({ code: z.literal(200), data: z.unknown() }).parse(
            JSON.parse(
              await read('https://api.cnstock.com/wap/news/newsDetails', {
                method: 'POST',
                body: JSON.stringify({ contId: id }),
                headers: { 'Content-Type': 'application/json', 'cnstock-client-type': '02' },
              }),
            ),
          ).data,
        );
      const publishedAt = localTime(row.pubTime);
      if (!recent(publishedAt)) continue;
      result.push({
        title: c.clean(row.title),
        url,
        publishedAt,
        sourceName: row.source || '上海证券报',
        excerpt: excerpt(row.textInfo.content) || c.clean(row.title),
      });
    }
  } else if (kind === 'cbimc') {
    const news = z.object({
      news_id: z.number(),
      news_title: z.string(),
      kind: z.number(),
      happen_time: z.number(),
    });
    const body = z
      .object({
        status: z.literal(0),
        data: z.object({ list: z.array(z.object({ newsList: z.array(news).optional() })) }),
      })
      .parse(JSON.parse(text));
    const seen = new Set<number>();
    for (const row of body.data.list.flatMap((x) => x.newsList ?? []).filter((x) => x.kind === 0)) {
      const publishedAt = new Date(row.happen_time).toISOString();
      const url = `https://www.cbimc.cn/news/${row.news_id}`;
      if (seen.has(row.news_id) || !recent(publishedAt) || (await c.exists(url))) continue;
      seen.add(row.news_id);
      const detail = z
        .object({
          status: z.literal(0),
          data: z.object({ content: z.string(), source: z.string().optional() }),
        })
        .parse(
          JSON.parse(
            await read('https://rm-api.cfmc.cn/web/news/getDetail', {
              method: 'POST',
              body: new URLSearchParams({
                data: JSON.stringify({ news_id: String(row.news_id) }),
              }).toString(),
            }),
          ),
        );
      result.push({
        title: c.clean(row.news_title),
        url,
        publishedAt,
        sourceName: detail.data.source || '中国银行保险报',
        excerpt: excerpt(detail.data.content) || c.clean(row.news_title),
      });
    }
  } else throw Error('未识别的金融信源');
  return result;
}
