import { z } from 'zod';

export function sourcePassages(excerpt: string) {
  const sentences = [...new Intl.Segmenter('zh', { granularity: 'sentence' }).segment(excerpt)];
  const texts = sentences.flatMap(({ segment }) => {
    const chunks: string[] = [];
    const characters = Array.from(segment);
    for (let start = 0; start < characters.length; start += 1000)
      chunks.push(characters.slice(start, start + 1000).join(''));
    return chunks;
  });
  return texts.filter((text) => text.length).map((text, index) => ({ id: `S${index + 1}`, text }));
}

export function sourceFactSchema(passages: ReturnType<typeof sourcePassages>) {
  const byId = new Map(passages.map((passage) => [passage.id, passage.text]));
  return z
    .object({
      statement: z.string().min(1).max(1000),
      evidenceIds: z
        .array(z.string())
        .min(1)
        .max(4)
        .superRefine((ids, ctx) => {
          ids.forEach((id, index) => {
            if (!byId.has(id))
              ctx.addIssue({
                code: 'custom',
                path: [index],
                message: `原文编号${id}不存在，请仅选择article.passages中的编号`,
              });
            if (ids.indexOf(id) !== index)
              ctx.addIssue({ code: 'custom', path: [index], message: '原文编号不能重复' });
          });
        }),
      status: z.enum(['confirmed', 'announced', 'planned', 'claim', 'rumor']),
      entities: z.array(z.string().max(100)).max(20).default([]),
    })
    .transform((fact) => ({
      ...fact,
      // Include intervening sentences so the stored quote is one exact source span.
      evidence: passages
        .slice(
          Math.min(...fact.evidenceIds.map((id) => passages.findIndex((p) => p.id === id))),
          Math.max(...fact.evidenceIds.map((id) => passages.findIndex((p) => p.id === id))) + 1,
        )
        .map((p) => p.text)
        .join(''),
    }));
}
