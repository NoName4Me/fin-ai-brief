import { z } from 'zod';
import { isJianyuSearch, jianyuItems, jianyuRequestOptions, jianyuSearchUrl } from './jianyu.ts';
export const cindaProcurementUrl =
  'https://www.cinda.com.cn/api/searcher/wtdf/json/searcher/acquisitionInfo';
export const hfDailyPapersUrl = 'https://huggingface.co/api/daily_papers?limit=20';
export { jianyuSearchUrl };
// 这些入口是官方公开接口，但不是标准 RSS，也不是通用 JSON 数组，需要各自的字段映射。
export type StructuredRequestContext = { now: Date; dailyTime: string };
export function structuredKind(
  input: string,
): 'cinda-procurement' | 'hf-daily-papers' | 'jianyu-search' | null {
  if (isJianyuSearch(input)) return 'jianyu-search';
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.origin === 'https://www.cinda.com.cn' && url.pathname.endsWith('/acquisitionInfo'))
    return 'cinda-procurement';
  if (url.origin === 'https://huggingface.co' && url.pathname === '/api/daily_papers')
    return 'hf-daily-papers';
  return null;
}
export function structuredRequestOptions(input: string, context?: StructuredRequestContext) {
  if (structuredKind(input) === 'jianyu-search')
    return jianyuRequestOptions(context?.now ?? new Date(), context?.dailyTime ?? '08:00');
  if (structuredKind(input) !== 'cinda-procurement') return {};
  return {
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      siteId: '1',
      includeSubChannel: 'true',
      sortBy: '2',
      channelId: '2558',
      currentPage: '1',
      pageSize: '20',
      namePath: '',
      searchText: '',
    }).toString(),
  };
}
type Item = {
  title: string;
  url: string;
  excerpt: string;
  publishedAt: string;
  publishedPrecision?: 'day' | 'time';
};
export function structuredItems(input: string, text: string): Item[] {
  const kind = structuredKind(input);
  if (kind === 'jianyu-search') return jianyuItems(text);
  if (kind === 'cinda-procurement') {
    const body = z
      .object({
        data: z.object({
          data: z.object({
            list: z.array(
              z.object({
                title: z.string(),
                static_path: z.string(),
                update_time: z.string().optional(),
                create_time: z.string().optional(),
                content: z.string().optional(),
              }),
            ),
          }),
        }),
      })
      .parse(JSON.parse(text));
    return body.data.data.list.flatMap((row) => {
      const date = /^\d{4}-\d{2}-\d{2}/.exec(row.update_time ?? row.create_time ?? '')?.[0];
      if (!date) return [];
      const url = new URL(row.static_path, 'https://www.cinda.com.cn');
      return [
        {
          title: row.title.slice(0, 500),
          url: url.href,
          excerpt: (row.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 16000) || row.title,
          publishedAt: `${date}T00:00:00+08:00`,
          publishedPrecision: 'day' as const,
        },
      ];
    });
  }
  if (kind === 'hf-daily-papers') {
    const body = z
      .array(
        z.object({
          paper: z.object({
            id: z.string(),
            title: z.string(),
            summary: z.string().optional(),
            publishedAt: z.string(),
          }),
        }),
      )
      .parse(JSON.parse(text));
    return body.flatMap((row) => {
      const publishedAt = new Date(row.paper.publishedAt);
      if (Number.isNaN(publishedAt.getTime())) return [];
      return [
        {
          title: row.paper.title.slice(0, 500),
          url: `https://huggingface.co/papers/${row.paper.id}`,
          excerpt:
            (row.paper.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 16000) ||
            row.paper.title,
          publishedAt: publishedAt.toISOString(),
        },
      ];
    });
  }
  return [];
}
