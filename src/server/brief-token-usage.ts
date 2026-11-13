import { pool } from './db.ts';
import { rangeFor } from './periods.ts';
import { screeningTokenShare } from './screening-usage.ts';

export type BriefTokenUsage = {
  current: number;
  previous: number | null;
};

export async function briefTokenUsage(
  currentDate: string,
  previousDate: string | null | undefined,
  dailyTime: string,
  now = new Date(),
): Promise<BriefTokenUsage> {
  const currentRange = rangeFor('daily', currentDate, dailyTime);
  const previousRange = previousDate ? rangeFor('daily', previousDate, dailyTime) : null;
  const currentEnd = new Date(Math.min(now.getTime(), currentRange.end.getTime()));
  const [briefs, articles] = await Promise.all([
    pool.query<{ subject: string; tokens: string }>(
      `SELECT subject,coalesce(sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)),0)::bigint tokens
       FROM model_calls WHERE subject=ANY($1::text[]) GROUP BY subject`,
      [
        previousDate
          ? [`brief:daily:${currentDate}`, `brief:daily:${previousDate}`]
          : [`brief:daily:${currentDate}`],
      ],
    ),
    pool.query<{ current: string; previous: string }>(
      `WITH eligible AS (
         SELECT id,created_at FROM articles WHERE (created_at >= $1 AND created_at < $2)
           OR ($3::timestamptz IS NOT NULL AND created_at >= $3 AND created_at < $4)
       ), usage AS (
         SELECT a.created_at,coalesce(mc.input_tokens,0)+coalesce(mc.output_tokens,0) tokens
         FROM eligible a JOIN model_calls mc ON mc.subject='article:'||a.id::text
         UNION ALL
         SELECT a.created_at,${screeningTokenShare('input_tokens')}+${screeningTokenShare('output_tokens')}
         FROM eligible a JOIN screening_usage_members sc ON sc.article_id=a.id
         JOIN model_calls mc ON mc.subject='screening:'||sc.batch_key
       ) SELECT
         coalesce(sum(tokens) FILTER (WHERE created_at >= $1 AND created_at < $2),0)::bigint current,
         coalesce(sum(tokens) FILTER (WHERE $3::timestamptz IS NOT NULL AND created_at >= $3 AND created_at < $4),0)::bigint previous
       FROM usage`,
      [currentRange.start, currentEnd, previousRange?.start ?? null, previousRange?.end ?? null],
    ),
  ]);
  const bySubject = new Map(briefs.rows.map((row) => [row.subject, Number(row.tokens)]));
  const articleTokens = articles.rows[0];
  return {
    current: (bySubject.get(`brief:daily:${currentDate}`) ?? 0) + Number(articleTokens.current),
    previous: previousDate
      ? (bySubject.get(`brief:daily:${previousDate}`) ?? 0) + Number(articleTokens.previous)
      : null,
  };
}
