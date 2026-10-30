import { loadRankingItems } from './ranking-sources.ts';
import { load } from 'cheerio';
import { localDate, validDate } from './periods.ts';
import type { SourceFetchOptions } from './fetch.ts';
import type { OfficialItem } from './source-details.ts';
import type { Provenance } from './types.ts';
export type WebItem = OfficialItem & { contentComplete?: boolean; provenance?: Provenance };
type Fetcher = (url: string, options?: SourceFetchOptions) => Promise<string | null>;
const text = (s: unknown) => {
  const $ = load(typeof s === 'string' ? s : '');
  $('script,style').remove();
  return $.text().replace(/\s+/g, ' ').trim();
};
export function webDate(value: string, now = new Date()): string | null {
  const full = /(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(value);
  let date = '';
  if (full) date = `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`;
  else {
    const relative = /(\d+)\s*(分钟|小时|天|minutes?|hours?|days?)\s*(?:前|ago)/i.exec(value);
    if (relative) {
      const unit = /分钟|minute/.test(relative[2])
        ? 60000
        : /小时|hour/.test(relative[2])
          ? 3600000
          : 86400000;
      date = localDate(new Date(now.getTime() - Number(relative[1]) * unit));
    } else {
      const part = /(\d{1,2})月(\d{1,2})日/.exec(value);
      if (part) {
        let year = Number(localDate(now).slice(0, 4));
        date = `${year}-${part[1].padStart(2, '0')}-${part[2].padStart(2, '0')}`;
        if (date > localDate(now)) date = `${year - 1}${date.slice(4)}`;
      } else if (/^[A-Z][a-z]+\s+\d{1,2},?\s+20\d{2}$/i.test(value.trim())) {
        const n = Date.parse(value + ' GMT+0800');
        if (Number.isFinite(n)) date = localDate(new Date(n));
      }
    }
  }
  return date && validDate(date) ? date + 'T00:00:00+08:00' : null;
}
function fromPath(url: string) {
  const m = /\/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})(?:\/|[-_])/.exec(url);
  return m ? webDate(`${m[1]}-${m[2]}-${m[3]}`) : null;
}
function jsString(object: string, key: string) {
  const m = new RegExp('\\b' + key + ':("(?:[^"\\\\]|\\\\.)*")').exec(object);
  return m ? (JSON.parse(m[1]) as string) : '';
}
export function embeddedWebRecords(html: string): Record<string, unknown>[] {
  const $ = load(html);
  const roots: unknown[] = [];
  $('script').each((_, el) => {
    const s = $(el).text();
    try {
      if ($(el).attr('type') === 'application/json' || $(el).attr('type') === 'application/ld+json')
        roots.push(JSON.parse(s));
      else {
        const m = /self\.__next_f\.push\((\[[\s\S]*\])\)\s*;?$/.exec(s);
        if (m) {
          const a = JSON.parse(m[1]);
          for (const value of a) {
            if (typeof value !== 'string') continue;
            for (const line of value.split('\n')) {
              const body = /^[\da-z]+:(.*)$/.exec(line)?.[1];
              if (body && /^[\[{]/.test(body)) {
                try {
                  roots.push(JSON.parse(body));
                } catch {}
              }
            }
          }
        }
      }
    } catch {}
  });
  const records: Record<string, unknown>[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    const o = v as Record<string, unknown>;
    records.push(o);
    Object.values(o).forEach(walk);
  };
  roots.forEach(walk);
  return records;
}
const profiles: Record<
  string,
  { cards: string; anchor: string; date?: string; summary?: string; title?: string }
> = {
  'www.01caijing.com': {
    cards: '.news-list dl',
    anchor: 'dd a:has(h2)',
    date: '.icon-time',
    summary: 'dd > p',
  },
  'www.cinda.com.cn': {
    cards: '.sGray.qym',
    anchor: 'strong a[href*="/xdxw/20"]',
  },
  'www.famc.citic': { cards: '.hrfc_text2', anchor: 'a[title]', date: '.hrfc_data' },
  'group2.ccb.com': { cards: 'ul.list li', anchor: 'a', date: 'span' },
  'www.pedata.cn': {
    cards: '.new_news_one',
    anchor: 'h2 a',
    date: '.new_news_one_bq span:first-child',
    summary: '.new_news_one_right > p',
  },
  'news.pedata.cn': {
    cards: '.new_news_one',
    anchor: 'h2 a',
    date: '.new_news_one_bq span:first-child',
    summary: '.new_news_one_right > p',
  },
  'www.zichanjie.com': {
    cards: '.text:has(h2.title)',
    anchor: 'h2.title a',
    date: '.tag .item',
    summary: '.desc',
  },
  'hai.stanford.edu': {
    cards: '[class*="ContentItem_headerText"],[class*="ContentCard_cardLower"]',
    anchor: 'a[href^="/news/"]',
    date: '[class*="ContentMeta_data"]',
  },
};
export function parseWebItems(html: string, input: string, now = new Date()): WebItem[] | null {
  const u = new URL(input),
    $ = load(html),
    items: WebItem[] = [],
    seen = new Set<string>();
  const add = (item: WebItem) => {
    if (item.title && item.publishedAt && !seen.has(item.url)) {
      seen.add(item.url);
      items.push({
        ...item,
        title: item.title.replace(/^[•·]\s*/, ''),
        excerpt: item.excerpt.slice(0, 16000),
      });
    }
  };
  if (u.hostname === 'www.cvsource.com.cn') {
    for (const r of embeddedWebRecords(html))
      if (
        typeof r.id === 'string' &&
        typeof r.title === 'string' &&
        typeof r.publishTime === 'number'
      )
        add({
          title: r.title,
          excerpt: typeof r.remark === 'string' ? r.remark : r.title,
          url: new URL('/report/' + r.id, u).href,
          publishedAt: new Date(r.publishTime).toISOString(),
        });
  } else if (u.hostname === 'www.ifenxi.com') {
    // Nuxt's public state includes dates absent from the visual cards. Read literal fields without executing scripts.
    for (const m of html.matchAll(/\{[^{}]*\bcontent_id:\d+[^{}]*\}/g)) {
      const date = webDate(jsString(m[0], 'date'), now),
        id = /\bcontent_id:(\d+)/.exec(m[0])?.[1];
      const title = jsString(m[0], 'title');
      if (date && id && title)
        add({
          title,
          excerpt: jsString(m[0], 'note') || title,
          url: new URL('/research/content/' + id, u).href,
          publishedAt: date,
          publishedPrecision: 'day',
        });
    }
  } else if (u.hostname === 'www.chinaventure.com.cn') {
    $('a[href*="/news/"]').each((_, el) => {
      const a = $(el),
        url = new URL(a.attr('href')!, u);
      const date = fromPath(url.href.replace(/-(20\d{6})-/, '/$1/'));
      const title = (a.attr('title') || a.find('h1,h2,h3,h4').text() || a.text()).trim();
      if (url.origin === u.origin && date && title.length > 6)
        add({
          title,
          excerpt: a.closest('li').find('p').text().trim() || title,
          url: url.href,
          publishedAt: date,
          publishedPrecision: 'day',
        });
    });
  } else if (u.hostname === 'www.cs.ecitic.com') {
    $('.li:has(.date)').each((_, el) => {
      const row = $(el),
        a = row.find('.right h2 a').first(),
        href = a.attr('href');
      const date = webDate(row.find('.date p').text() + '-' + row.find('.date h2').text());
      if (!href || !date) return;
      const url = new URL(href, u);
      if (url.origin !== u.origin && url.hostname !== 'mp.weixin.qq.com') return;
      const title = a.text().trim();
      add({
        title,
        excerpt: row.find('[name="abstractContent"]').text().trim() || title,
        url: url.href,
        publishedAt: date,
        publishedPrecision: 'day',
      });
    });
  } else if (u.hostname === 'arena.ai') {
    $('[class*="post-paragraph"]').each((_, el) => {
      const p = $(el),
        row = p.parent();
      const heading = row.children().not(p).text().trim(),
        date = webDate(heading, now);
      if (!date) return;
      const excerpt = p.text().trim();
      add({
        title: `Arena 榜单更新 ${date.slice(0, 10)}`,
        excerpt,
        url: new URL('?date=' + date.slice(0, 10), u).href,
        publishedAt: date,
        publishedPrecision: 'day',
        contentComplete: true,
      });
    });
  } else if (profiles[u.hostname]) {
    const p =
      u.hostname === 'www.famc.citic' && /^\/hrxw\/hrzs\//.test(u.pathname)
        ? { cards: '.jgml_list > ul', anchor: '.list_text6 a[href]', date: '.list_text5' }
        : profiles[u.hostname];
    $(p.cards).each((_, el) => {
      const row = $(el),
        a = row.find(p.anchor).first(),
        href = a.attr('href');
      if (!href) return;
      const url = new URL(href, u);
      if (url.origin !== u.origin) return;
      if (
        u.hostname === 'www.famc.citic' &&
        /^\/hrxw\/hrzs\//.test(u.pathname) &&
        !/^\/hrxw\/hrzs\/\d{4}\/\d+\.shtml$/.test(url.pathname)
      )
        return;
      const date = webDate(p.date ? row.find(p.date).text() : '', now) || fromPath(url.href);
      if (!date) return;
      const title = (a.attr('title') || a.text()).trim();
      add({
        title,
        excerpt: p.summary ? row.find(p.summary).text().trim() || title : title,
        url: url.href,
        publishedAt: date,
        publishedPrecision: 'day',
      });
    });
  } else return null;
  if (!items.length) throw new Error('网页列表未解析到具备明确日期的资讯，请检查入口或页面结构');
  return items;
}
export function parseTldrIssue(html: string, url: string): WebItem[] {
  const $ = load(html),
    date = webDate(url.match(/20\d{2}-\d{2}-\d{2}/)?.[0] ?? '');
  if (!date) throw Error('TLDR期刊日期缺失');
  const items: WebItem[] = [];
  $('article').each((_, el) => {
    const row = $(el),
      a = row.find('a:has(h3)').first(),
      href = a.attr('href'),
      title = a.find('h3').text().trim(),
      excerpt = row.find('.newsletter-html').text().trim();
    if (!href || !title || !excerpt || /\(Sponsor\)/i.test(title)) return;
    const original = new URL(href.replace(/&amp;/g, '&'), url);
    if (!/^https?:$/.test(original.protocol)) return;
    items.push({
      title,
      excerpt: excerpt.slice(0, 16000),
      url: original.href,
      publishedAt: date,
      publishedPrecision: 'day',
      contentComplete: true,
      provenance: {
        itemId: original.href,
        category: 'AI newsletter',
        attribution: { name: 'TLDR AI', url },
        canonical: original.href,
      },
    });
  });
  return items;
}
export async function loadWebItems(
  html: string,
  input: string,
  fetcher: Fetcher,
  now = new Date(),
): Promise<WebItem[] | null> {
  const ranking = await loadRankingItems(html, input, fetcher, now);
  if (ranking) return ranking;
  const u = new URL(input);
  if (u.hostname === 'tldr.tech') {
    const $ = load(html),
      issues = new Set<string>();
    $('a[href]').each((_, el) => {
      const url = new URL($(el).attr('href')!, u);
      const date = /^\/ai\/(20\d{2}-\d{2}-\d{2})$/.exec(url.pathname)?.[1];
      if (
        date &&
        Date.parse(date + 'T00:00:00+08:00') >= now.getTime() - 7 * 86400000 &&
        Date.parse(date + 'T00:00:00+08:00') <= now.getTime()
      )
        issues.add(url.href);
    });
    if (!issues.size) throw Error('TLDR AI归档中没有近7天期刊');
    const items: WebItem[] = [];
    for (const url of [...issues].slice(0, 7)) {
      const body = await fetcher(url);
      if (!body) throw Error('TLDR期刊读取失败');
      items.push(...parseTldrIssue(body, url));
    }
    if (!items.length) throw Error('TLDR期刊未解析到正文摘要');
    return items;
  }
  if (u.hostname === 'www.cebnet.com.cn') {
    const $ = load(html);
    const path = $('#catalogPath').val();
    if (typeof path !== 'string' || !/^[a-zA-Z0-9/_-]+$/.test(path))
      throw Error('中国电子银行网栏目索引缺失');
    const body = await fetcher(new URL('/json/' + path + 'index.json', u).href);
    if (!body) throw Error('中国电子银行网栏目数据读取失败');
    const data = JSON.parse(body);
    if (!Array.isArray(data.list)) throw Error('中国电子银行网栏目格式已变化');
    return data.list.map(
      (r: { title: string; summary: string; articleLink: string; pubTime: string }) => ({
        title: text(r.title),
        excerpt: text(r.summary) || text(r.title),
        url: new URL(r.articleLink.replace('/json/', '/').replace(/\.json$/, '.html'), u).href,
        publishedAt: r.pubTime.replace(' ', 'T') + '+08:00',
      }),
    );
  }
  if (u.hostname === 'www.cs.com.cn') {
    const guide = /<script[^>]+src=["']([^"']*mi4_page_articles_guide\.js)["']/.exec(html)?.[1];
    if (!guide) throw Error('中国证券报列表未找到内容索引');
    const guideUrl = new URL(guide, u);
    const script = await fetcher(guideUrl.href);
    if (!script) throw Error('中国证券报内容索引读取失败');
    const raw = /PAGE_INDEX_MAP\s*=\s*(\{[^\r\n]+\})/.exec(script)?.[1];
    if (!raw) throw Error('中国证券报索引格式已变化');
    const map = JSON.parse(raw) as Record<string, string>,
      items: WebItem[] = [];
    for (const name of Object.values(map)
      .filter((n) => {
        const date = /^mi4_sub_articles_(20\d{2})(\d{2})(\d{2})\.js$/.exec(n);
        return (
          date &&
          `${date[1]}-${date[2]}-${date[3]}` >= localDate(new Date(now.getTime() - 7 * 86400000)) &&
          `${date[1]}-${date[2]}-${date[3]}` <= localDate(now)
        );
      })
      .slice(0, 8)) {
      const body = await fetcher(new URL(name, guideUrl).href);
      if (!body) throw Error('中国证券报日期列表读取失败');
      const array = /MI4_PAGE_ARTICLE\s*=\s*(\[[\s\S]*\])\s*;?\s*$/.exec(body)?.[1];
      if (!array) throw Error('中国证券报文章数据格式已变化');
      for (const row of JSON.parse(array)) {
        if (!row.title || !row.url || typeof row.pub_date !== 'string') continue;
        items.push({
          title: text(row.title),
          url: new URL(row.url, u).href,
          excerpt: text(row.miSummary) || text(row.title),
          publishedAt:
            row.pub_date.replace(' ', 'T') + (row.pub_date.length === 16 ? ':00' : '') + '+08:00',
        });
      }
    }
    return items;
  }
  if (u.hostname === 'www.cmbchina.com') {
    const body = await fetcher(new URL('/api/v1/cms/list/paged', u).href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ web: 'CmbinfoNews', pageIndex: 1, pageSize: 20 }),
    });
    if (!body) throw Error('招商银行栏目数据读取失败');
    const data = JSON.parse(body);
    if (data.returnCode !== 'SUC0000' || !Array.isArray(data.body?.pages))
      throw Error('招商银行栏目数据格式已变化');
    return data.body.pages.map(
      (r: {
        guid: string;
        title: string;
        linkFlag: boolean;
        linkUrl: string;
        timeEffective: string;
        contentInfo: string;
        metaInfo: string;
      }) => ({
        title: r.title,
        url: r.linkFlag ? r.linkUrl : new URL('/cmbinfo/newsnewsinfo.aspx?guid=' + r.guid, u).href,
        excerpt: (text(r.contentInfo) || text(r.metaInfo) || r.title).slice(0, 16000),
        publishedAt: r.timeEffective.replace(' ', 'T') + '+08:00',
        contentComplete: text(r.contentInfo).length >= 20,
      }),
    );
  }
  if (u.hostname === 'www.gwamcc.com') {
    const api = new URL('/Ajax/GetArticleList.ashx', u);
    api.search = new URLSearchParams({
      pIndex: '1',
      pSize: '8',
      liName: u.searchParams.get('liName') || '11',
      titleLength: '32',
      summaryLength: '75',
    }).toString();
    const body = await fetcher(api.href);
    if (!body) throw Error('长城资产栏目数据读取失败');
    const data = JSON.parse(body);
    if (!Array.isArray(data.ds)) throw Error('长城资产栏目格式已变化');
    return data.ds.map((r: { ID: number; Title: string; Summary: string; ActionDate: string }) => ({
      title: text(r.Title),
      excerpt: text(r.Summary) || text(r.Title),
      url: new URL('/NewsDetails.aspx?liName=11&ID=' + r.ID, u).href,
      publishedAt: webDate(r.ActionDate, now)!,
      publishedPrecision: 'day' as const,
    }));
  }
  return parseWebItems(html, input, now);
}
