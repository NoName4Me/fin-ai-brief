import { z } from 'zod';
import type { Settings } from './types.ts';

type Draft = { overview: Record<string, string>; items: { eventId: string; summary: string }[] };
type Limits = Pick<
  Settings,
  'financeSummaryMaxLength' | 'financeOverviewMaxLength' | 'briefLengthTolerancePercent'
>;

export function briefLengthRepair(
  content: Draft,
  config: Limits,
  events: { id: string; industryId: string }[],
) {
  const segments: {
    id: string;
    text: string;
    currentLength: number;
    maxLength: number;
    acceptedMaxLength: number;
  }[] = [];
  const add = (id: string, text: string, maxLength: number) => {
    const currentLength = [...text].length;
    const acceptedMaxLength = Math.floor(
      (maxLength * (100 + config.briefLengthTolerancePercent)) / 100,
    );
    if (currentLength > acceptedMaxLength)
      segments.push({ id, text, currentLength, maxLength, acceptedMaxLength });
  };
  for (const item of content.items) {
    if (events.some((event) => event.id === item.eventId && event.industryId === 'finance'))
      add(`summary:${item.eventId}`, item.summary, config.financeSummaryMaxLength);
  }
  if (content.overview.finance !== undefined)
    add('overview:finance', content.overview.finance, config.financeOverviewMaxLength);
  if (!segments.length) return undefined;

  const schema = z
    .strictObject({
      segments: z
        .array(z.strictObject({ id: z.string(), text: z.string().trim().min(1).max(2000) }))
        .min(1)
        .max(51),
    })
    .superRefine((value, ctx) => {
      const ids = value.segments.map((segment) => segment.id);
      if (
        new Set(ids).size !== ids.length ||
        ids.some((id) => !segments.some((segment) => segment.id === id)) ||
        segments.some((segment) => !ids.includes(segment.id))
      )
        ctx.addIssue({
          code: 'custom',
          message: '压缩结果必须且只能包含本次指定的段落，每段恰好一次',
          path: ['segments'],
        });
      value.segments.forEach((segment, index) => {
        const expected = segments.find((original) => original.id === segment.id);
        const actual = [...segment.text].length;
        if (expected && actual > expected.acceptedMaxLength)
          ctx.addIssue({
            code: 'custom',
            message: `${segment.id}压缩后仍有${actual}字，请压缩至${expected.maxLength}字以内`,
            path: ['segments', index, 'text'],
          });
      });
    });
  const system = `你是简报文字编辑。只压缩给定segments中的超长段落，每段压缩至maxLength字以内（含标点）。currentLength为实际字数。保留原文核心事实、关键数字、时间、主体及计划或已发生的状态，不增加新事实，不机械截断，不输出省略号代替正文。每段返回原id与压缩后的text，不修改或新增其他段落。只输出JSON，格式示例：${JSON.stringify({ segments: [{ id: segments[0].id, text: '压缩后的正文' }] })}。`;
  return {
    system,
    input: { segments: segments.map(({ acceptedMaxLength, ...segment }) => segment) },
    schema,
  };
}

export function applyBriefLengthRepair<T extends Draft>(
  content: T,
  result: { segments: { id: string; text: string }[] },
): T {
  const replacements = new Map(result.segments.map((segment) => [segment.id, segment.text]));
  return {
    ...content,
    overview: {
      ...content.overview,
      ...(replacements.has('overview:finance')
        ? { finance: replacements.get('overview:finance')! }
        : {}),
    },
    items: content.items.map((item) => ({
      ...item,
      summary: replacements.get(`summary:${item.eventId}`) ?? item.summary,
    })),
  };
}
