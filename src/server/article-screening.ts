import { createHash } from 'node:crypto';
import { z } from 'zod';

export const screeningTimeoutMs = 60_000;
export const screeningDecision = z.object({
  decision: z.enum(['continue', 'exclude', 'uncertain']),
  reason: z.string().min(1).max(200),
});
export const screeningPrompt = `你是数智参阅的资讯初筛编辑。根据文章材料、编辑方针及信源允许参与的栏目，判断是否值得交给后续编辑分析。
只在材料明确不涉及实质AI内容、不属于允许栏目，或明确没有可核查事实时输出 exclude。普通金融新闻和泛数字化本身不属于AI；监管、金融或产业报道有具体AI事实时应继续。不要用关键词的有无做结论，也不要判断是否重复报道。材料不足以排除或边界不明确时输出 uncertain。其余输出 continue。
格式：{"decision":"continue","reason":"一句话说明依据"}。`;

export function screeningCohort(id: string, createdAt: Date, startsAt: string | undefined) {
  const start = startsAt ? Date.parse(startsAt) : NaN;
  if (!Number.isFinite(start) || createdAt.getTime() < start) return null;
  const bucket = createHash('sha256').update(id).digest().readUInt32BE(0) % 100;
  return bucket < 8 ? 'gate' : bucket < 10 ? 'audit' : null;
}
