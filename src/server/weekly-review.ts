import { z } from 'zod';
import { db, pool } from './db.ts';
import { articles, events } from './schema.ts';
import { and, inArray, lt, asc, eq } from 'drizzle-orm';
import { localDate } from './periods.ts';
import {
  ratingForEditorial,
  resolveSection,
  fixedSections,
  type SectionRule,
  type RatingRule,
} from './editorial.ts';
import type { BriefContent } from './types.ts';

const factSchema = z.object({
  statement: z.string(),
  evidence: z.string(),
  status: z.string(),
});
const editorialSchema = z.object({
  title: z.string(),
  summary: z.string(),
  section: z.string(),
  score: z.number(),
});
export type Development = {
  id: string;
  event_id: string;
  article_id: string;
  facts: unknown;
  happened_at: Date;
  editorial: unknown;
};
export const writtenProgressSchema = z
  .array(
    z.object({
      text: z.string().trim().min(1).max(160),
      developmentIds: z.array(z.uuid()).min(1).max(30),
    }),
  )
  .max(8);
export type WrittenProgress = z.infer<typeof writtenProgressSchema>;
export type WeeklyMaterials = Awaited<ReturnType<typeof weeklyMaterials>>;
const normalized = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

export async function weeklyMaterials(
  range: { start: Date; end: Date },
  minScore: number,
  maxItems: number,
  editorialConfig?: { sections: SectionRule[]; ratingRules: RatingRule[] },
) {
  // Select by period developments, never by the event's mutable latest occurrence time.
  const candidates = await pool.query<
    typeof events.$inferSelect & { editorial: unknown; last_report: Date }
  >(
    `
    SELECT e.*, e.industry_id AS "industryId", e.occurred_at AS "occurredAt", e.updated_at AS "updatedAt",
      latest.editorial, latest.happened_at AS last_report
    FROM events e
    JOIN LATERAL (
      SELECT d.editorial,d.happened_at FROM event_developments d
      JOIN articles a ON a.id=d.article_id AND a.event_id=d.event_id AND a.state='processed'
      LEFT JOIN sources s ON s.id=a.source_id
      WHERE d.event_id=e.id AND d.happened_at >= $1 AND d.happened_at < $2
        AND a.published_at >= $1 AND a.published_at < $2
        AND (s.id IS NULL OR s.sections='[]'::jsonb OR s.sections ? COALESCE($3::jsonb->>COALESCE(d.editorial->>'section',e.section),d.editorial->>'section',e.section))
      ORDER BY d.happened_at DESC,d.created_at DESC,d.id DESC LIMIT 1
    ) latest ON true`,
    [
      range.start,
      range.end,
      JSON.stringify(
        Object.fromEntries(
          (editorialConfig?.sections ?? []).flatMap((s) => s.aliases.map((a) => [a, s.name])),
        ),
      ),
    ],
  );
  let unscored = 0;
  const evaluated = candidates.rows.map((event) => {
    const snapshot = editorialSchema.safeParse(event.editorial);
    const original = {
      ...event,
      ...(snapshot.success ? snapshot.data : {}),
      occurredAt: event.last_report,
      missingRating: false,
    };
    if (!editorialConfig) return original;
    const section = resolveSection(original.section, editorialConfig.sections);
    const active = fixedSections(editorialConfig.sections).some((s) => s.name === section);
    const rating = ratingForEditorial(event.editorial, editorialConfig.ratingRules);
    if (active && original.score > 0 && rating === null) unscored++;
    return {
      ...original,
      section,
      missingRating: active && original.score > 0 && rating === null,
      score: active && original.score > 0 && rating !== null ? rating * 20 : -1,
    };
  });
  const unscoredEvents = evaluated.filter((event) => event.missingRating);
  const selected = evaluated
    .filter((event) => event.score >= minScore)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.occurredAt.getTime() - a.occurredAt.getTime() ||
        a.id.localeCompare(b.id),
    )
    .slice(0, maxItems);
  if (!selected.length)
    return {
      selected,
      refs: [],
      developments: [] as Development[],
      inputEvents: [],
      unscored,
      unscoredEvents,
    };
  const ids = selected.map((event) => event.id);
  const refs = await db
    .select()
    .from(articles)
    .where(
      and(
        inArray(articles.eventId, ids),
        lt(articles.publishedAt, range.end),
        eq(articles.state, 'processed'),
      ),
    )
    .orderBy(asc(articles.publishedAt), asc(articles.id));
  const developments = (
    await pool.query<Development>(
      `
    SELECT d.* FROM event_developments d JOIN articles a ON a.id=d.article_id AND a.event_id=d.event_id
    WHERE d.event_id=ANY($1::uuid[]) AND d.happened_at < $2 AND a.published_at < $2
      AND a.state='processed'
    ORDER BY d.happened_at,d.created_at,d.id`,
      [ids, range.end],
    )
  ).rows;
  const inputEvents = selected.map((event) => {
    const week = developments.filter(
      (d) => d.event_id === event.id && d.happened_at >= range.start,
    );
    const background = developments
      .filter((d) => d.event_id === event.id && d.happened_at < range.start)
      .slice(-2);
    const materialIds = new Set([...week, ...background].map((d) => d.article_id));
    // Do not expose the event's current title/summary: they can contain later facts.
    return {
      id: event.id,
      industryId: event.industryId,
      section: event.section,
      developments: week.map((d) => ({
        id: d.id,
        articleId: d.article_id,
        reportedAt: d.happened_at,
        facts: factSchema.array().parse(d.facts),
      })),
      background: background.map((d) => ({
        reportedAt: d.happened_at,
        facts: factSchema.array().parse(d.facts),
      })),
      sources: refs
        .filter(
          (a) => materialIds.has(a.id) || (a.eventId === event.id && a.publishedAt >= range.start),
        )
        .map((a) => ({
          id: a.id,
          title: a.title,
          excerpt: a.excerpt,
          publishedAt: a.publishedAt,
        })),
    };
  });
  const usedIds = new Set(
    developments
      .filter(
        (d) =>
          d.happened_at >= range.start ||
          inputEvents.some((e) => e.sources.some((s) => s.id === d.article_id)),
      )
      .map((d) => d.article_id),
  );
  return {
    selected,
    refs: refs.filter((a) => usedIds.has(a.id) || a.publishedAt >= range.start),
    developments,
    inputEvents,
    unscored,
    unscoredEvents,
  };
}

export function weeklyProgress(
  eventId: string,
  written: WrittenProgress,
  materials: Pick<WeeklyMaterials, 'refs' | 'developments'>,
  range: { start: Date; end: Date },
): NonNullable<BriefContent['items'][number]['progress']> {
  if (written.length === 1) throw new Error('连续进展至少需要两个节点；单次变化请只写综合摘要');
  const used = new Set<string>();
  const factsUsed = new Set<string>();
  const textUsed = new Set<string>();
  return [...written]
    .sort((a, b) => {
      const time = (node: WrittenProgress[number]) =>
        Math.min(
          ...node.developmentIds.map(
            (id) =>
              materials.developments.find((d) => d.id === id)?.happened_at.getTime() ?? Infinity,
          ),
        );
      return time(a) - time(b);
    })
    .map((node) => {
      const textKey = normalized(node.text);
      if (!textKey || textUsed.has(textKey)) throw new Error('周报进展为空或重复');
      textUsed.add(textKey);
      const developments = node.developmentIds.map((id) => {
        const d = materials.developments.find((d) => d.id === id && d.event_id === eventId);
        if (!d || d.happened_at < range.start || d.happened_at >= range.end)
          throw new Error('周报进展引用无效或超出本期范围');
        if (used.has(id)) throw new Error('同一进展依据不能重复分成多个节点');
        used.add(id);
        return d;
      });
      const evidence = developments.flatMap((d) => {
        const article = materials.refs.find((a) => a.id === d.article_id);
        if (
          !article ||
          article.eventId !== eventId ||
          article.publishedAt < range.start ||
          article.publishedAt >= range.end
        )
          throw new Error('周报进展缺少本期来源依据');
        return factSchema
          .array()
          .parse(d.facts)
          .map((fact) => {
            if (!fact.evidence || !article.excerpt.includes(fact.evidence))
              throw new Error('周报进展依据不在来源摘要中');
            return {
              sourceUrl: article.url,
              statement: fact.statement,
              excerpt: fact.evidence,
              status: fact.status,
            };
          });
      });
      if (!evidence.length) throw new Error('周报进展没有事实依据');
      const keys = new Set(evidence.map((f) => normalized(f.statement) + ':' + f.status));
      if ([...keys].every((key) => factsUsed.has(key)))
        throw new Error('重复报道不能作为新的周报进展');
      keys.forEach((key) => factsUsed.add(key));
      const firstDate = localDate(
        new Date(Math.min(...developments.map((d) => d.happened_at.getTime()))),
      );
      const lastDate = localDate(
        new Date(Math.max(...developments.map((d) => d.happened_at.getTime()))),
      );
      return {
        ...(firstDate !== lastDate ? { endDate: lastDate } : {}),
        date: localDate(new Date(Math.min(...developments.map((d) => d.happened_at.getTime())))),
        text: node.text,
        sourceUrls: [...new Set(evidence.map((e) => e.sourceUrl))],
        evidence,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
