import { createHash } from 'node:crypto';
import { z } from 'zod';
import { briefContentSchema } from '../src/server/types.ts';
const entrySchema = z.object({
  domain: z.enum(['finance', 'ai']),
  cat: z.string(),
  title: z.string(),
  summary: z.string(),
  emphasis: z.array(z.string()),
  url: z.url(),
  source: z.string(),
  publishedAt: z.string(),
  timeNote: z.string(),
  detail: z.string(),
  announcementUrl: z.url().optional(),
  timingIndexUrl: z.url().optional(),
});
function constant(html: string, name: string): unknown {
  const line = html.match(new RegExp(`(?:^|\\n)const ${name}=(.+);(?:\\r?\\n|$)`));
  if (!line) throw new Error(`视觉稿缺少 ${name} 数据`);
  return JSON.parse(line[1]);
}
function eventId(url: string) {
  const bytes = createHash('sha256')
    .update(`fin-ai-brief:2026-10-22:${url}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const sections: Record<string, string> = {
  金融监管: '行业监管',
  资管与基金: '行业进展',
  报告选读: '相关报告',
  金融机构: '行业进展',
  头部厂商与产业: '行业动态',
  Claude平台进展: 'AI 产品',
  技术研究: '论文',
  模型与应用: 'AI 产品',
};
export function readReferenceSnapshot(html: string) {
  const entries = z.array(entrySchema).length(8).parse(constant(html, 'data'));
  const overviews = z
    .object({ daily: z.object({ finance: z.string(), ai: z.string() }) })
    .parse(constant(html, 'domainOverviews'));
  if (entries.some((item) => !item.publishedAt.startsWith('2026-10-22')))
    throw new Error('视觉稿日期与待导入的期次不符');
  const title = html.match(/data-heading-caption=""[^>]*>([^<]+)</)?.[1];
  if (!title) throw new Error('视觉稿缺少本期主题');
  return briefContentSchema.parse({
    title,
    overview: overviews.daily,
    rangeStart: '2026-10-21T16:00:00.000Z',
    rangeEnd: '2026-10-22T07:40:00.000Z',
    note: '本期采用提供的2026年10月22日视觉稿选读资料，统计截至15:40；为人工整理快照，不代表持续采集或模型生成。原稿中的来源、发布时间口径和事实边界予以保留。',
    items: entries.map((item) => ({
      eventId: eventId(item.url),
      industryId: item.domain,
      section: sections[item.cat] ?? item.cat,
      title: item.title,
      summary: item.summary,
      emphasis: item.emphasis,
      sources: [
        {
          name: item.source,
          title: item.title,
          url: item.url,
          publishedAt:
            item.publishedAt.length === 10
              ? item.publishedAt
              : new Date(item.publishedAt).toISOString(),
          timeNote: item.timeNote,
          detail: item.detail,
          announcementUrl: item.announcementUrl,
          timingIndexUrl: item.timingIndexUrl,
        },
      ],
    })),
  });
}
