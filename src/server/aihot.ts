import { z } from 'zod';
export const aihotSections: Record<string, string> = {
  'ai-models': 'AI 模型',
  'ai-products': 'AI 产品',
  industry: '行业动态',
  paper: '论文',
  tip: '教程',
  opinion: '观点',
};
const httpUrl = z.url().refine((url) => /^https?:/.test(url));
const aihotItem = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  source: z.object({ name: z.string() }),
  links: z.object({ original: httpUrl.nullable(), aihot: httpUrl }),
  publishedAt: z.iso.datetime().nullable(),
  category: z.string(),
  attribution: z.object({ name: z.string(), url: httpUrl }),
});
export function isAihotItemsUrl(input: string) {
  const url = new URL(input);
  return url.hostname === 'aihot.news' && url.pathname === '/api/v1/items';
}
export function validateAihotUrl(input: string) {
  const url = new URL(input);
  if (
    url.origin !== 'https://aihot.news' ||
    url.pathname !== '/api/v1/items' ||
    url.username ||
    url.password
  )
    throw new Error('AIHOT 接入地址应为 https://aihot.news/api/v1/items');
}
export function parseAihotItems(text: string) {
  const body = z
    .object({ schemaVersion: z.literal(1), items: z.array(aihotItem).max(100) })
    .parse(JSON.parse(text));
  return body.items.flatMap((item) =>
    !item.publishedAt || !item.links.original
      ? []
      : [
          {
            title: item.title,
            url: item.links.original,
            excerpt: item.summary ?? item.title,
            publishedAt: item.publishedAt,
            sourceName: item.source.name,
            provenance: {
              itemId: item.id,
              category: aihotSections[item.category] ?? item.category,
              attribution: item.attribution,
              canonical: item.links.aihot,
            },
          },
        ],
  );
}
