import { financeKind } from './finance-sources.ts';
// 新智元官方文章列表提供日期级时间；不把日期冒充具体发布时间。
export function validateHtmlSourceUrl(input: string) {
  if (financeKind(input) === 'cnstock') return;
  const url = new URL(input);
  if (
    url.protocol !== 'https:' ||
    !['aiera.com.cn', 'www.aiera.com.cn'].includes(url.hostname) ||
    url.pathname !== '/asi-articles.html' ||
    url.username ||
    url.password
  )
    throw new Error('网页采集支持新智元官方文章列表和上证报金融频道');
}
export function parseHtmlItems(text: string, input: string, clean: (value: string) => string) {
  validateHtmlSourceUrl(input);
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
