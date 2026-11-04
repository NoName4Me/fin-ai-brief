import { pool } from './db.ts';
import type { BriefContent } from './types.ts';

export const followupWritingRule =
  'previousCoverage是此前14天已刊内容，仅用于辨认旧闻，不能作为本期新增事实的来源。对照本期developments，只写本次实质新增信息；已刊融资金额、发布动作或评级不得再次作为新消息写入标题、要览和摘要。后续分析可报道新增的具体条件、证据或结论，必须保留原始日期与归属。';

export async function previousCoverage(cutoff: Date) {
  const { rows } = await pool.query<{
    date: string;
    content: BriefContent;
  }>(
    `SELECT period_date::text AS date,published AS content FROM briefs
     WHERE kind='daily' AND published IS NOT NULL AND published_at < $1
       AND period_date < ($1 AT TIME ZONE 'Asia/Shanghai')::date
       AND period_date >= ($1 AT TIME ZONE 'Asia/Shanghai')::date - 14
     ORDER BY period_date DESC`,
    [cutoff],
  );
  return rows.map(({ date, content }) => ({
    date,
    title: content.title,
    items: content.items.map(({ eventId, title, summary }) => ({ eventId, title, summary })),
    highlights: content.highlights ?? [],
  }));
}

export function coverageForCandidates(
  history: Awaited<ReturnType<typeof previousCoverage>>,
  candidateIds: ReadonlySet<string>,
) {
  return history.flatMap(({ date, items }) => {
    const matches = items.filter(({ eventId }) => candidateIds.has(eventId));
    return matches.length ? [{ date, items: matches }] : [];
  });
}
