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
    )
    .map((section) => ({
      ...section,
      currentLength: section.items.reduce((n, i) => n + [...(i.title + i.summary)].length, 0),
      items: section.items.map((item, index) => ({
        ...item,
        currentLength: [...(item.title + item.summary)].length,
        maxLength:
          Math.floor(section.budget / section.items.length) +
          (index < section.budget % section.items.length ? 1 : 0),
      })),
    }));
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
        if (length > section.limit) {
          const details = section.items
            .map((item) => {
              const current = v.items.find((i) => i.eventId === item.eventId);
              const actual = current ? [...(current.title + current.summary)].length : 0;
              return `${item.eventId}当前${actual}字，建议不超过${item.maxLength}字（标题与摘要合计）`;
            })
            .join('；');
          fail(
            `${section.name}超过字数要求（${length}字），请压缩至${section.budget}字以内。${details}`,
          );
        }
      }
    });
  return {
    system:
      '你是数智参阅文字编辑。只压缩提供的超长栏目，不改变事实、数字、归属、计划或不确定性，不补充新信息。输出{items:[{eventId,title,summary}]}，仅返回给定事件且每个一次。currentLength是程序计算的实际字数，包含标点、数字与英文字符。按每条maxLength分配标题与摘要合计字数，每组总计不得超过budget字；先缩短标题，再将摘要改写为简短事实句，删去背景、重复解释和非必要评价，保留关键事实与限定条件。不要机械截断。不要输出未超限栏目、要览或其他字段。',
    input: { sections: sections.map(({ limit, ...section }) => section) },
    schema,
  };
}
