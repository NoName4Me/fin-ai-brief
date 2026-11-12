import { z } from 'zod';
import { recallScore } from './process.ts';

export type PublishedReport = {
  date: string;
  eventId: string;
  title: string;
  summary: string;
};
export type PublicationCandidate = { id: string; title: string; summary: string };
export type PublicationDecision = {
  decision: 'new' | 'duplicate' | 'update';
  previousEventId: string | null;
  newFactIndexes: number[];
  reason: string;
};

// Includes internal reasoning as well as the final JSON; not a target output length.
export const publicationCheckMaxTokens = 8000;

export const publicationCheckPrompt =
  '你是日刊编辑，只判断本次事件相对过去7天实际刊登内容是否有新增信息。previousCoverage是已刊内容，不能作为本次新增事实来源。逐项比较facts：同公司不代表同事件；转载、改标题、报道日期变新或补充旧背景不构成进展。未报道过的具体事项返回new；同事件无新增事实返回duplicate；有明确新增事实返回update，newFactIndexes只列新增事实的零起始索引。媒体传闻、计划、厂商自述等状态改变必须有本次材料支持。输出{decision:"new|duplicate|update",previousEventId:null,newFactIndexes:[],reason:"简短理由"}。update或duplicate必须引用给定已刊eventId；new必须为null。只使用提供的材料。';

export function recallPublishedReports(event: PublicationCandidate, reports: PublishedReport[]) {
  const grouped = new Map<string, PublishedReport[]>();
  for (const report of reports) {
    const group = grouped.get(report.eventId) ?? [];
    group.push(report);
    grouped.set(report.eventId, group);
  }
  const text = event.title + ' ' + event.summary;
  return [...grouped]
    .map(([eventId, entries]) => ({
      eventId,
      reports: entries.map(({ date, title, summary }) => ({ date, title, summary })),
      score:
        eventId === event.id
          ? Number.POSITIVE_INFINITY
          : Math.max(
              ...entries.map((report) => recallScore(text, report.title + ' ' + report.summary)),
            ),
    }))
    .sort((a, b) => b.score - a.score || a.eventId.localeCompare(b.eventId))
    .slice(0, 24)
    .map(({ score: _score, ...entry }) => entry);
}

export function publicationDecisionSchema(previousIds: string[], factCount: number) {
  return z
    .object({
      decision: z.enum(['new', 'duplicate', 'update']),
      previousEventId: z.uuid().nullable(),
      newFactIndexes: z
        .array(
          z
            .number()
            .int()
            .min(0)
            .max(Math.max(0, factCount - 1), {
              message: `当前${factCount}条事实，合法索引为0至${Math.max(0, factCount - 1)}`,
            }),
        )
        .default([]),
      reason: z.string().min(1).max(500),
    })
    .superRefine((value, ctx) => {
      const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
      if (value.decision === 'new' && value.previousEventId !== null)
        fail('首次报道不能引用已刊事件');
      if (value.decision !== 'new' && !previousIds.includes(value.previousEventId ?? ''))
        fail('重复或进展必须引用给定已刊事件');
      if (
        new Set(value.newFactIndexes).size !== value.newFactIndexes.length ||
        value.newFactIndexes.some((index) => index >= factCount)
      )
        fail(
          `新增事实索引重复或超出facts范围；当前${factCount}条事实，合法索引为0至${factCount - 1}`,
        );
      if (value.decision === 'update' && !value.newFactIndexes.length)
        fail('进展必须提供至少一条有依据的新增事实');
      if (value.decision === 'duplicate' && value.newFactIndexes.length)
        fail('重复报道不能标记新增事实');
    });
}

// Each original slot gets at most one replacement; each column has just two reserves.
export async function selectPublicationCandidates<T extends PublicationCandidate>(
  events: T[],
  maxItems: number,
  check: (event: T) => Promise<PublicationDecision | undefined>,
) {
  const pool = events.slice(0, maxItems + 2);
  const selected: T[] = [];
  const decisions = new Map<string, PublicationDecision>();
  let nextReserve = maxItems;
  let cached = true;
  const accept = async (event: T) => {
    const result = await check(event);
    if (!result) cached = false;
    else decisions.set(event.id, result);
    if (result?.decision === 'duplicate') return false;
    selected.push(event);
    return true;
  };
  for (const event of pool.slice(0, maxItems)) {
    if (!(await accept(event)) && nextReserve < pool.length) await accept(pool[nextReserve++]!);
  }
  return { selected, decisions, cached };
}
