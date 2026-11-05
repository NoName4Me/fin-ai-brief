import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  screeningDecision as decision,
  screeningPrompt as prompt,
  screeningTimeoutMs as timeoutMs,
} from '../src/server/article-screening.ts';
import { pool } from '../src/server/db.ts';
import { modelUsage, requestModel, requireModelConfig } from '../src/server/model.ts';

const perGroup = 6;
const sampleSize = perGroup * 6;
const concurrency = 6;
const previousReport = z.object({
  checks: z.array(z.object({ subject: z.string(), decision: z.string() })),
});

type Sample = {
  subject: string;
  category: string;
  relevant: boolean;
  baselineTokens: number | null;
  material: { article: unknown; industry: unknown; sectionRules: unknown };
};

type Check = {
  subject: string;
  category: string;
  relevant: boolean;
  decision: z.infer<typeof decision>['decision'] | 'error';
  error?: string;
  reason?: string;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
  elapsedMs: number;
  baselineTokens: number | null;
};

try {
  const recent = process.argv[2] === '--recent';
  const args = process.argv.slice(recent ? 3 : 2);
  const retry = args[0] === '--retry-errors';
  const replay = args[0] === '--replay';
  if (replay && args.length !== 2) throw new Error('请提供需要对照的报告路径');
  if (retry && args.length !== 2) throw new Error('请提供需要复跑的报告路径');
  const batchSize = retry ? 2 : recent || replay ? 3 : concurrency;
  const selectedSubjects =
    retry || replay
      ? previousReport
          .parse(JSON.parse(await readFile(args[1], 'utf8')))
          .checks.filter((row) => replay || row.decision === 'error')
          .map((row) => row.subject)
      : [];
  if ((retry || replay) && !selectedSubjects.length) throw new Error('报告没有需要复跑的失败请求');
  const previousSubjects = (
    await Promise.all(
      (retry || replay ? [] : args).map(async (path) => {
        const report = previousReport.parse(JSON.parse(await readFile(path, 'utf8')));
        return report.checks.map(({ subject }) => subject);
      }),
    )
  ).flat();
  const config = await requireModelConfig();
  const { remaining } = await modelUsage();
  if (remaining < sampleSize * 2) throw new Error('当日模型调用余量不足，跳过试跑');
  const { rows } = await pool.query<Sample>(
    `WITH latest AS (
       SELECT DISTINCT ON (subject) subject, response, input_summary, created_at, input_tokens + output_tokens AS baseline_tokens
       FROM model_calls
       WHERE purpose='article' AND state='succeeded' AND ($7::boolean OR model=$1)
         AND subject LIKE 'article:%' AND response->>'relevant' IN ('true','false')
         AND input_summary->'input' ? 'article' AND ($7::boolean OR created_at >= now() - CASE WHEN $6::boolean THEN interval '3 hours' ELSE interval '7 days' END)
         AND NOT (subject = ANY($2::text[]))
         AND (NOT $4::boolean OR subject = ANY($5::text[]))
       ORDER BY subject, created_at DESC, id DESC
     ), materials AS (
       SELECT subject, (response->>'relevant')::boolean AS relevant, input_summary->'input' AS input, created_at, baseline_tokens
       FROM latest
     ), classified AS (
       SELECT *, CASE
         WHEN input->'article'->>'title' ~ '监管|条例|管理办法|合规|指导意见|征求意见|审查|反垄断'
           OR input->'article'->>'source' ~ '国家发展改革委|金融监管总局|人民银行'
           THEN '监管'
         WHEN input->'article'->>'source' ~ '华尔街见闻|21世纪经济报道|移动支付网|银行|证券|未央网'
           THEN '金融'
         WHEN input->'article'->>'source' ~ '虎嗅|IT桔子|投中网|剑鱼标讯|The Information'
           THEN '产业'
         ELSE '其他'
       END AS category
       FROM materials
     ), ranked AS (
       SELECT *, row_number() OVER (PARTITION BY category, relevant ORDER BY md5(subject)) AS rank
       FROM classified WHERE category <> '其他' OR $6::boolean OR $7::boolean
     )
     SELECT subject, category, relevant, baseline_tokens AS "baselineTokens",
       jsonb_build_object('article', input->'article', 'industry', input->'industry',
                          'sectionRules', input->'sectionRules') AS material
     FROM ranked WHERE $6::boolean OR $7::boolean OR rank <= $3
     ORDER BY CASE WHEN $7::boolean THEN array_position($5::text[], subject) END,
              CASE WHEN $6::boolean THEN created_at END DESC, rank, category, relevant
     LIMIT CASE WHEN $6::boolean THEN 24 ELSE NULL END`,
    [config.model, previousSubjects, perGroup, retry || replay, selectedSubjects, recent, replay],
  );
  if (!rows.length) throw new Error('没有可对照的近期文章');
  if (replay && rows.length !== selectedSubjects.length) throw new Error('原报告样本不完整');

  // Use completed analyses as the baseline; do not write to the application database.
  const checks: Check[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    checks.push(
      ...(await Promise.all(
        rows
          .slice(i, i + batchSize)
          .map(
            async ({ subject, category, relevant, baselineTokens, material }): Promise<Check> => {
              const started = performance.now();
              let inputTokens = 0;
              let outputTokens = 0;
              let attempts = 0;
              try {
                const { value } = await requestModel(
                  prompt,
                  material,
                  decision,
                  config,
                  (url, init) => {
                    attempts++;
                    return fetch(url, {
                      ...init,
                      signal: AbortSignal.timeout(timeoutMs),
                    });
                  },
                  1600,
                  async (input, output) => {
                    inputTokens = input;
                    outputTokens = output;
                  },
                );
                return {
                  subject,
                  category,
                  relevant,
                  decision: value.decision,
                  ...(relevant && value.decision === 'exclude' ? { reason: value.reason } : {}),
                  inputTokens,
                  outputTokens,
                  attempts,
                  elapsedMs: Math.round(performance.now() - started),
                  baselineTokens,
                };
              } catch (error) {
                const message = error instanceof Error ? error.message : '';
                const status = message.match(/HTTP (\d{3})/);
                return {
                  subject,
                  category,
                  relevant,
                  decision: 'error',
                  error: status
                    ? `HTTP ${status[1]}`
                    : message.includes('达到上限')
                      ? '输出达到上限'
                      : error instanceof Error && error.name === 'TimeoutError'
                        ? '请求超时'
                        : '请求失败或响应无效',
                  inputTokens,
                  outputTokens,
                  attempts,
                  elapsedMs: Math.round(performance.now() - started),
                  baselineTokens,
                };
              }
            },
          ),
      )),
    );
  }
  const count = (predicate: (row: Check) => boolean) => checks.filter(predicate).length;
  const successfulTimes = checks
    .filter((row) => row.decision !== 'error')
    .map((row) => row.elapsedMs)
    .sort((a, b) => a - b);
  const percentile = (p: number) =>
    successfulTimes[Math.ceil(successfulTimes.length * p) - 1] ?? null;
  console.log(
    JSON.stringify(
      {
        model: config.model,
        timeoutMs,
        completedOver20s: count((row) => row.decision !== 'error' && row.elapsedMs > 20_000),
        sample: checks.length,
        baselineRelevant: count((row) => row.relevant),
        baselineIrrelevant: count((row) => !row.relevant),
        missedRelevant: count((row) => row.relevant && row.decision === 'exclude'),
        excludedIrrelevant: count((row) => !row.relevant && row.decision === 'exclude'),
        uncertain: count((row) => row.decision === 'uncertain'),
        p50Ms: percentile(0.5),
        p90Ms: percentile(0.9),
        errors: count((row) => row.decision === 'error'),
        inputTokens: checks.reduce((total, row) => total + row.inputTokens, 0),
        outputTokens: checks.reduce((total, row) => total + row.outputTokens, 0),
        attempts: checks.reduce((total, row) => total + row.attempts, 0),
        checks,
      },
      null,
      2,
    ),
  );
  if (checks.every((row) => row.decision === 'error')) process.exitCode = 1;
} finally {
  await pool.end();
}
