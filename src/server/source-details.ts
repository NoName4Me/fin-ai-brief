import { load } from 'cheerio';
import { localDate, validDate } from './periods.ts';
import type { SourceFetchOptions } from './fetch.ts';
export function isNfraList(input: string) {
  const u = new URL(input);
  return u.origin === 'https://www.nfra.gov.cn' && u.pathname === '/cn/view/pages/ItemList.html';
}
export type OfficialItem = {
  title: string;
  excerpt: string;
  url: string;
  publishedAt: string;
  publishedPrecision?: 'day' | 'time' | 'observed';
};
export function officialListItems(
  text: string,
  input: string,
  now = new Date(),
): OfficialItem[] | null {
  const u = new URL(input);
  if (isNfraList(input)) {
    const body = JSON.parse(text);
    if (body.rptCode !== 200 || !Array.isArray(body.data?.rows))
      throw new Error('金融监管总局列表格式已变化');
    return body.data.rows.map((r: { docId: number; docTitle: string; publishDate: string }) => ({
      title: r.docTitle,
      excerpt: r.docTitle,
      url: `https://www.nfra.gov.cn/cn/view/pages/ItemDetail.html?docId=${r.docId}&itemId=${u.searchParams.get('itemId')}`,
      publishedAt: r.publishDate.replace(' ', 'T') + '+08:00',
    }));
  }
  if (u.origin === 'https://www.ndrc.gov.cn' && u.pathname === '/xxgk/wjk/index.html') {
    const body = JSON.parse(text);
    if (body.code !== 200 || !Array.isArray(body.data?.resultList))
      throw new Error('发改委文件库列表格式已变化');
    return body.data.resultList.map((row: { title: string; url: string; docDate: string }) => {
      const url = new URL(row.url, input);
      if (url.origin !== u.origin) throw new Error('发改委文件原文地址不属于官方网站');
      const title = load(row.title).text().trim();
      return {
        title,
        excerpt: title,
        url: url.href,
        publishedAt: `${row.docDate}T00:00:00+08:00`,
        publishedPrecision: 'day' as const,
      };
    });
  }
  if (u.origin === 'https://www.cbimc.cn' && /^\/channel\/\d+\/\d+$/.test(u.pathname)) {
    const body = JSON.parse(text);
    if (body.status !== 0 || !Array.isArray(body.data?.newsList))
      throw new Error('中国银行保险报栏目列表格式已变化');
    const seen = new Set<number>();
    const rows = [
      ...(body.data.topList ?? []),
      ...(body.data.bannerNewsList ?? []),
      ...body.data.newsList,
    ] as { news_id: number; news_title: string; happen_time: number; flag: number }[];
    return rows
      .filter((row) => {
        if (seen.has(row.news_id) || ![0, 1].includes(row.flag)) return false;
        seen.add(row.news_id);
        return true;
      })
      .map((row) => ({
        title: row.news_title,
        excerpt: row.news_title,
        url: `https://www.cbimc.cn/news/${row.news_id}`,
        publishedAt: new Date(row.happen_time).toISOString(),
      }));
  }
  if (u.hostname === 'www.21jingji.com') {
    const $ = load(text);
    const items: OfficialItem[] = [];
    const seen = new Set<string>();
    $('.col-l .news > a[href]').each((_, el) => {
      const a = $(el),
        href = a.attr('href');
      if (!href) return;
      const url = new URL(href, input);
      if (
        !['www.21jingji.com', 'm.21jingji.com'].includes(url.hostname) ||
        url.protocol !== 'https:'
      )
        return;
      const date = /\/article\/(20\d{2})(\d{2})(\d{2})\//.exec(url.pathname);
      const title = (a.attr('title') || a.find('h2').text()).trim();
      if (!date || !title || seen.has(url.href)) return;
      seen.add(url.href);
      items.push({
        title,
        excerpt: a.find('p').first().text().trim() || title,
        url: url.href,
        publishedAt: `${date[1]}-${date[2]}-${date[3]}T00:00:00+08:00`,
        publishedPrecision: 'day',
      });
    });
    if (!items.length) throw new Error('21世纪经济报道栏目未解析到资讯，请检查页面结构');
    return items;
  }
  if (u.hostname === 'www.stcn.com') {
    const $ = load(text);
    const items: OfficialItem[] = [];
    const seen = new Set<string>();
    $('.infinite-list > li').each((_, el) => {
      const row = $(el),
        a = row.find('.tt a[href]').first();
      const href = a.attr('href'),
        title = a.text().trim();
      if (!href || !title) return;
      const url = new URL(href, input);
      if (
        url.origin !== u.origin ||
        !/^\/article\/detail\/\d+\.html$/.test(url.pathname) ||
        seen.has(url.href)
      )
        return;
      const raw = row.find('.info span').last().text().trim();
      const today = localDate(now);
      let stamp = '';
      if (/^\d{2}:\d{2}$/.test(raw)) stamp = `${today}T${raw}:00+08:00`;
      else {
        const parts = /^(?:(20\d{2})-)?(\d{2})-(\d{2})\s+(\d{2}:\d{2})$/.exec(raw);
        if (parts) {
          let year = parts[1] ?? today.slice(0, 4);
          stamp = `${year}-${parts[2]}-${parts[3]}T${parts[4]}:00+08:00`;
          if (!parts[1] && Date.parse(stamp) > now.getTime()) {
            year = String(Number(year) - 1);
            stamp = `${year}-${parts[2]}-${parts[3]}T${parts[4]}:00+08:00`;
          }
        }
      }
      if (!stamp || !validDate(stamp.slice(0, 10)) || !Number.isFinite(Date.parse(stamp))) return;
      seen.add(url.href);
      items.push({
        title,
        excerpt: row.find('.text').first().text().trim() || title,
        url: url.href,
        publishedAt: stamp,
        publishedPrecision: 'time',
      });
    });
    if (!items.length) throw new Error('证券时报列表未解析到带时间的资讯，请检查页面结构');
    return items;
  }
  if (u.hostname === 'www.financialnews.com.cn') {
    const $ = load(text);
    const items: OfficialItem[] = [];
    const seen = new Set<string>();
    $('.news-list dl').each((_, el) => {
      const row = $(el);
      const a = row.find('h4 a[href]').first();
      const href = a.attr('href');
      const date = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(row.find('h6').text())?.[1];
      const title = (a.attr('title') || a.text()).trim();
      if (!href || !date || !title) return;
      const url = new URL(href, input);
      if (
        url.hostname !== u.hostname ||
        !/^https?:$/.test(url.protocol) ||
        !/\/content_\d+\.html$/.test(url.pathname)
      )
        return;
      url.protocol = 'https:';
      if (seen.has(url.href)) return;
      seen.add(url.href);
      items.push({
        title,
        excerpt: row.find('dd > p').first().text().trim() || title,
        url: url.href,
        publishedAt: `${date}T00:00:00+08:00`,
        publishedPrecision: 'day',
      });
    });
    if (!items.length) throw new Error('金融时报列表未解析到带日期的资讯，请检查页面结构');
    return items;
  }
  if (u.hostname === 'www.mof.gov.cn') {
    const $ = load(text);
    const items: OfficialItem[] = [];
    const seen = new Set<string>();
    $('li').each((_, el) => {
      const row = $(el);
      const a = row.find('a[href]').first();
      const href = a.attr('href');
      const date = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(row.find('span').text())?.[1];
      if (!href || !date) return;
      const url = new URL(href, input);
      if (
        !(url.hostname === 'mof.gov.cn' || url.hostname.endsWith('.mof.gov.cn')) ||
        !/^https?:$/.test(url.protocol)
      )
        return;
      url.protocol = 'https:';
      const title = (a.attr('title') || a.text()).trim();
      if (!title || seen.has(url.href)) return;
      seen.add(url.href);
      items.push({
        title,
        excerpt: title,
        url: url.href,
        publishedAt: `${date}T00:00:00+08:00`,
        publishedPrecision: 'day',
      });
    });
    if (!items.length) throw new Error('财政部列表未解析到带日期的资讯，请检查页面结构');
    return items;
  }
  if (!['www.pbc.gov.cn', 'www.cac.gov.cn'].includes(u.hostname)) return null;
  const $ = load(text);
  const items: {
    title: string;
    excerpt: string;
    url: string;
    publishedAt: string;
    publishedPrecision: 'day';
  }[] = [];
  const seen = new Set<string>();
  $('a[href]').each((_, el) => {
    const a = $(el);
    const href = a.attr('href');
    if (!href) return;
    const url = new URL(href, input);
    if (url.origin !== u.origin || !/\/(?:\d{10,}\/index\.html|c_\d+\.htm)$/.test(url.pathname))
      return;
    const row = a.closest(u.hostname === 'www.cac.gov.cn' ? 'li' : 'td');
    const date = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(row.text())?.[1];
    const title = (a.attr('title') || a.text()).trim();
    if (!date || !title || seen.has(url.href)) return;
    seen.add(url.href);
    items.push({
      title,
      excerpt: title,
      url: url.href,
      publishedAt: `${date}T00:00:00+08:00`,
      publishedPrecision: 'day',
    });
  });
  if (!items.length) throw new Error('官网列表未解析到带日期的资讯，请检查页面结构');
  return items;
}
export class UnsupportedSourceContentError extends Error {}
export async function readSourceDetail(
  url: string,
  fetcher: (url: string, options?: SourceFetchOptions) => Promise<string | null>,
) {
  const u = new URL(url);
  const nfra =
    u.origin === 'https://www.nfra.gov.cn' && u.pathname === '/cn/view/pages/ItemDetail.html';
  const target = nfra
    ? `https://www.nfra.gov.cn/cbircweb/DocInfo/SelectByDocId?docId=${u.searchParams.get('docId')}`
    : url;
  let html = await fetcher(target);
  if (!html) throw new Error('详情页返回空响应');
  if (nfra) {
    const data = JSON.parse(html);
    if (data.rptCode !== 200 || typeof data.data?.docClob !== 'string')
      throw new Error('金融监管总局详情缺少正文');
    html = data.data.docClob;
  }
  const $ = load(html!);
  const pdf = $('#pdfAdd1').text().trim() || $('a[href$=".pdf"]').first().attr('href');
  const originalTitle = $('h1,.article_title,.detail-title h3').first().text().trim();
  $(
    'script,style,nav,header,footer,iframe,.share,.print,[style*="display:none"],[style*="display: none"]',
  ).remove();
  const selectors: Record<string, string> = {
    'www.cs.com.cn': 'article.cont_article > section',
    'www.cebnet.com.cn': '.article-content',
    'www.01caijing.com': 'article#content .details-article',
    'www.ifenxi.com': '.research-content__main-body-left-content',
    'www.famc.citic': '.blzcwz_text',
    'group2.ccb.com': '#article_content',
    'news.pedata.cn': '.article_con',
    'www.pedata.cn': '.article_con',
    'www.chinaventure.com.cn': '.article_slice_pc',
    'www.zichanjie.com': '.arcticle-detail > .content',
    'www.cvsource.com.cn': '#report-content > [class*="_left__"]',
    'hai.stanford.edu': 'section[class*="Article_content"]',
    'mp.weixin.qq.com': '#js_content',
  };
  if (u.hostname === 'mp.weixin.qq.com' && !$('#js_content').length)
    throw new Error('微信文章需要验证，暂时无法读取正文');
  const content = nfra
    ? $('body')
    : $(
        selectors[u.hostname] ??
          '[id="zoom"],#Zoom,#TRS_AUTOADD,#UCAP-CONTENT,.TRS_Editor,article,.article-content,.content-detail,#BodyLabel,.detail-cont,.detail-content,.txtContent .main_content,[class^="pageCenter___"] > [class^="content___"]',
      ).first();
  if (!content.length) throw new Error('详情页未识别到正文区域');
  let excerpt = content.text().replace(/\s+/g, ' ').trim();
  if (excerpt.length < 80 && pdf) {
    const attachment = new URL(pdf, url);
    if (attachment.origin !== u.origin) throw new Error('正文附件不属于同一官网');
    const data = await fetcher(attachment.href, { binaryBase64: true });
    if (!data) throw new Error('正文附件返回空响应');
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({
      data: new Uint8Array(Buffer.from(data, 'base64')),
      useSystemFonts: true,
    });
    const doc = await loading.promise;
    try {
      const pages: string[] = [];
      for (let i = 1; i <= Math.min(doc.numPages, 100); i++) {
        const page = await doc.getPage(i);
        const text = await page.getTextContent();
        pages.push(text.items.map((item) => ('str' in item ? item.str : '')).join(' '));
        if (pages.join(' ').length >= 12000) break;
      }
      excerpt = pages.join(' ').replace(/\s+/g, ' ').trim();
    } finally {
      await loading.destroy();
    }
  }
  if (!excerpt && content.find('img').length)
    throw new UnsupportedSourceContentError('详情页仅含图片，没有可读取的文字正文');
  if (excerpt.length < 20) throw new Error('详情页正文不足或仅含附件');
  const title = (
    originalTitle ||
    $('meta[name="ArticleTitle"],meta[property="og:title"]').attr('content') ||
    ''
  ).trim();
  return { excerpt: excerpt.slice(0, 12000), ...(title ? { title: title.slice(0, 500) } : {}) };
}
