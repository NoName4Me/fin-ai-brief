import { z } from 'zod';
import { budgetLimit } from './editorial-limits.ts';
import type { WeeklyMaterials } from './weekly-review.ts';

export function dailyRotationRequest(
  date: string,
  rule: {
    name: string;
    description: string;
    keywords: string;
    budget: number;
    minItems: number;
    maxItems: number;
  },
  events: WeeklyMaterials['inputEvents'],
  editorialPrompt: string,
  tolerancePercent: number,
) {
  const references = new Map(
    events.map((event, index) => [`E${String(index + 1).padStart(2, '0')}`, event.id]),
  );
  const refs = [...references.keys()];
  const allowed = refs.join('、');
  const example = JSON.stringify({
    observation: { text: '综合正文', eventRefs: refs.slice(0, rule.minItems) },
  });
  const limit = budgetLimit(rule.budget, tolerancePercent);
  const schema = z
    .strictObject({
      observation: z
        .strictObject({
          text: z.string().trim().min(1),
          eventRefs: z.array(z.string()),
        })
        .nullable(),
    })
    .superRefine(({ observation }, ctx) => {
      if (!observation) return;
      const { text, eventRefs } = observation;
      const fail = (path: (string | number)[], message: string) =>
        ctx.addIssue({ code: 'custom', path: ['observation', ...path], message });
      if ([...text].length > limit)
        fail(
          ['text'],
          `正文当前${[...text].length}字，超过上限${limit}字，请压缩至预算${rule.budget}字以内`,
        );
      if (eventRefs.length < rule.minItems || eventRefs.length > rule.maxItems)
        fail(
          ['eventRefs'],
          `当前引用${eventRefs.length}个事件，必须引用${rule.minItems}至${rule.maxItems}个不同事件`,
        );
      eventRefs.forEach((ref, index) => {
        if (!references.has(ref))
          fail(
            ['eventRefs', index],
            `无效事件编号${ref}；只能原样选用：${allowed}。不得使用来源文章或事件进展ID`,
          );
        if (eventRefs.indexOf(ref) !== index)
          fail(['eventRefs', index], `事件编号${ref}重复，每个事件只能引用一次`);
      });
    });
  return {
    system: `你是数智参阅编辑。${editorialPrompt}只生成当前一个轮动栏目的综合正文，不能将各事件拆成多个栏目。输出且仅输出${example}；资料不足时输出{"observation":null}。不输出栏目名称、标题、rotations或eventIds。eventRefs必须原样复制events.ref中的编号，引用${rule.minItems}至${rule.maxItems}个不同事件，不能使用内部ID或自编编号。遵守栏目description、keywords和budget，所有事实、机构、数字和案例必须来自所引用事件。developments为本期进展，background仅供背景；保留事实状态、归属和不确定性，不能把观察或采集时点当成发布时间。正文为纯文本。`,
    input: {
      date,
      column: rule,
      events: events.map((event, index) => ({
        ref: refs[index],
        section: event.section,
        developments: event.developments.map(({ reportedAt, facts }) => ({ reportedAt, facts })),
        background: event.background,
        sources: event.sources.map(({ title, publishedAt, observedAt, publishedPrecision }) => ({
          title,
          publishedAt,
          observedAt,
          publishedPrecision,
        })),
      })),
    },
    schema,
    resolve: ({ observation }: z.infer<typeof schema>) =>
      observation
        ? {
            name: rule.name,
            text: observation.text,
            eventIds: observation.eventRefs.map((ref) => references.get(ref)!),
          }
        : null,
  };
}
