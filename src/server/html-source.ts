import { financeKind } from './finance-sources.ts';
export function isAieraArticleList(input: string) {
  try {
    const url = new URL(input);
    return (
      url.protocol === 'https:' &&
      ['aiera.com.cn', 'www.aiera.com.cn'].includes(url.hostname) &&
      url.pathname === '/asi-articles.html'
    );
  } catch {
    return false;
  }
}
// 新智元官方文章列表提供日期级时间；不把日期冒充具体发布时间。
export function validateHtmlSourceUrl(input: string) {
  if (financeKind(input) === 'cnstock') return;
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('网页采集入口必须是公开的 HTTPS 地址');
}

const navigation =
  /^(首页|更多|登录|注册|退出|下一页|上一页|返回|English|中文|关于我们|联系我们|网站地图|版权声明|用户协议|隐私政策|广告服务|招聘|友情链接|设为首页|加入收藏|今日建行首页|企业社会责任|集团网站|网站声明|人才招聘|客户服务|网点查询)$/;
const datePattern = /(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?/;
const months: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
// 英文站点常见 “October 27, 2026” 或 “27 October 2026” 两种顺序。
function englishDate(context: string) {
  const m =
    /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(context) ??
    /(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(context);
  if (!m) return null;
  const monthName = (months[m[1].toLowerCase()] ? m[1] : m[2]).toLowerCase();
  const day = Number(months[m[1].toLowerCase()] ? m[2] : m[1]);
  const year = Number(m[3]);
  const month = months[monthName];
  if (!month || !day || !year) return null;
  return [year, month, day] as const;
}

// 通用网页列表适配：同一站点的文章链接，附近带有年月日即视为一条候选。
// 只取日期级时间，并交由采集流程按时间窗过滤；无法确认日期的链接不进入候选。
export function parseGenericHtmlItems(
  text: string,
  input: string,
  clean: (value: string) => string,
  now = new Date(),
) {
  const origin = new URL(input).origin;
  const seen = new Set<string>();
  const items: {
    title: string;
    url: string;
    excerpt: string;
    publishedAt: string;
    publishedPrecision: 'day';
  }[] = [];
  for (const match of text.matchAll(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi,
  )) {
    let url: URL;
    try {
      url = new URL(match[1], input);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    if (/\.(?:jpg|jpeg|png|gif|svg|webp|css|js|pdf|zip|rar|mp4)$/i.test(url.pathname)) continue;
    const inner = match[2];
    const title = clean(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(inner)?.[1] ?? inner).replace(
      /^[•·\-–—|]+\s*/,
      '',
    );
    if (!title || title.length < 6 || title.length > 180 || navigation.test(title)) continue;
    const start = Math.max(0, (match.index ?? 0) - 1200);
    const context = text.slice(start, (match.index ?? 0) + match[0].length + 600);
    const date = datePattern.exec(context);
    const parsed = date
      ? ([Number(date[1]), Number(date[2]), Number(date[3])] as const)
      : englishDate(context);
    if (!parsed) continue;
    const [year, month, day] = parsed;
    if (year < 2020 || month < 1 || month > 12 || day < 1 || day > 31) continue;
    const publishedAt = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00+08:00`;
    const time = Date.parse(publishedAt);
    if (Number.isNaN(time) || time > now.getTime() + 86400000) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const paragraph = /<p\b[^>]*>([\s\S]{0,400}?)<\/p>/i.exec(context)?.[1];
    items.push({
      title,
      url: url.href,
      excerpt: (paragraph ? clean(paragraph) : '') || title,
      publishedAt,
      publishedPrecision: 'day',
    });
    if (items.length >= 100) break;
  }
  return items;
}
export function parseHtmlItems(
  text: string,
  input: string,
  clean: (value: string) => string,
  now = new Date(),
) {
  validateHtmlSourceUrl(input);
  if (!isAieraArticleList(input)) return parseGenericHtmlItems(text, input, clean, now);
  return [...text.matchAll(/<a\b[^>]*class="art"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .slice(0, 100)
    .flatMap((match) => {
      const title = clean(/<h3[^>]*>([\s\S]*?)<\/h3>/.exec(match[2])?.[1] ?? '');
      const excerpt = clean(/<p[^>]*>([\s\S]*?)<\/p>/.exec(match[2])?.[1] ?? '');
      const date = /<span>(\d{4})\.(\d{2})\.(\d{2})<\/span>/.exec(match[2]);
      const url = new URL(match[1], input);
      if (
        !title ||
        !excerpt ||
        !date ||
        url.origin !== new URL(input).origin ||
        url.pathname !== '/asi-post.html' ||
        !/^\d+$/.test(url.searchParams.get('id') ?? '')
      )
        return [];
      const publishedAt = `${date[1]}-${date[2]}-${date[3]}T00:00:00+08:00`;
      if (Number.isNaN(Date.parse(publishedAt))) return [];
      return [{ title, url: url.href, excerpt, publishedAt, publishedPrecision: 'day' as const }];
    });
}
