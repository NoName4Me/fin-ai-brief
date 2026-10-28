import { z } from 'zod';
import { budgetLimit } from './editorial-limits.ts';
type Item = { eventId: string; title: string; summary: string };
export function dailyLengthRepair(
  items: Item[],
  events: { id: string; section: string }[],
  rules: { name: string; budget: number }[],
  tolerancePercent = 0,
) {
  const sections = rules
    .map((rule) => ({
      ...rule,
      limit: budgetLimit(rule.budget, tolerancePercent),
      items: items.filter((i) => events.find((e) => e.id === i.eventId)?.section === rule.name),
    }))
    .filter(
      (rule) => rule.items.reduce((n, i) => n + [...(i.title + i.summary)].length, 0) > rule.limit,
    );
  if (!sections.length) return undefined;
  const targets = sections.flatMap((s) => s.items.map((i) => i.eventId));
  const schema = z
    .object({
      items: z
        .array(
          z.object({
            eventId: z.uuid(),
            title: z.string().min(1).max(200),
            summary: z.string().min(1).max(2000),
          }),
        )
        .min(1)
        .max(50),
    })
    .superRefine((v, ctx) => {
      const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
      const ids = v.items.map((i) => i.eventId);
      if (
        ids.length !== targets.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !targets.includes(id))
      )
        fail('压缩不得遗漏、重复或添加事件');
      for (const section of sections) {
        const length = v.items
          .filter((i) => section.items.some((old) => old.eventId === i.eventId))
          .reduce((n, i) => n + [...(i.title + i.summary)].length, 0);
        if (length > section.limit)
          fail(`${section.name}超过${section.limit}字上限（含容差）（${length}字）`);
      }
    });
  return {
    system:
      '你是数智参阅文字编辑。只压缩提供的超长栏目，不改变事实、数字、归属、计划或不确定性，不补充新信息。输出{items:[{eventId,title,summary}]}，仅返回给定事件且每个一次。每组全部标题与摘要合计以budget为目标，允许在limit内保留必要事实，绝不可超过limit；优先保留关键事实和条件；可以缩短标题。不要输出未超限栏目、要览或其他字段。',
    input: { sections },
    schema,
  };
}
