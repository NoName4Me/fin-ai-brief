import { and, desc, eq, gte, lt, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, pool } from './db.ts';
import { articles, events, sources } from './schema.ts';
import { allowedSourceSections } from './source-config.ts';
import {
  assessmentSchema,
  ratingInstructionsFor,
  assessmentFor,
  fixedSections,
  weightedRating,
  keywordMatches,
} from './editorial.ts';
import { sourcePassages, sourceFactSchema } from './source-evidence.ts';
import { modelJSON, getModelConnection } from './model.ts';
import { getSettings } from './settings.ts';
import { fingerprint, stage } from './processing-log.ts';
import { rangeFor, localDate } from './periods.ts';
class EventChanged extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventChanged';
  }
}
export const PROCESS_VERSION = 'ai-editorial-v10';
function decisionSchema(passages: ReturnType<typeof sourcePassages>) {
  const selectedDecisionSchema = z.object({
    relevant: z.literal(true),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(2000),
    section: z.string(),
    assessment: assessmentSchema,
    tags: z
      .array(z.string().max(40))
      .max(12)
      .default([])
      .transform((): string[] => []),
    scoreReason: z.string().max(1000).default(''),
    existingEventId: z.uuid().nullable(),
    facts: z
      .array(sourceFactSchema(passages))
      .max(
        12,
        '事实条目最多12条。请筛选、合并为最多12条核心事实，覆盖标题和摘要中的主要陈述；不要逐句罗列全文',
      )
      .default([]),
    newFactIndexes: z.array(z.number().int().min(0)).max(12).optional(),
    novelty: z.enum(['new', 'update', 'duplicate']).default('new'),
    needsReview: z.boolean().default(false),
    conflict: z.boolean().default(false),
  });
  return z.preprocess(
    (value) => {
      if (
        !value ||
        typeof value !== 'object' ||
        (value as { relevant?: unknown }).relevant !== true
      )
        return value;
      const output = { ...(value as Record<string, unknown>) };
      if (!output.assessment || typeof output.assessment !== 'object') return output;
      const { scoreReason, ...assessment } = output.assessment as Record<string, unknown>;
      output.assessment = assessment;
      if (!output.scoreReason && typeof scoreReason === 'string') output.scoreReason = scoreReason;
      return output;
    },
    z.discriminatedUnion('relevant', [
      selectedDecisionSchema,
      z.object({
        relevant: z.literal(false),
        reason: z.string().max(1000).default('与AI没有实质关联'),
      }),
    ]),
  );
}
export function recallScore(a: string, b: string) {
  const tokens = (value: string) => {
    const normalized = value.normalize('NFKC').toLowerCase();
    const terms: string[] = normalized.match(/[a-z][a-z0-9-]+|[0-9]+(?:\.[0-9]+)?/g) ?? [];
    for (const run of normalized.match(/[\u4e00-\u9fff]+/g) ?? [])
      for (let i = 0; i < run.length - 1; i++) terms.push(run.slice(i, i + 2));
    return new Set(terms);
  };
  const left = tokens(a),
    right = tokens(b);
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += /^[a-z0-9]/.test(token) ? 5 : 1;
  const weight = (terms: Set<string>) =>
    [...terms].reduce((n, t) => n + (/^[a-z0-9]/.test(t) ? 5 : 1), 0);
  return overlap / Math.sqrt(Math.max(1, weight(left) * weight(right)));
}
export async function processArticle(id: string, reprocessBatchId?: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await processArticleAttempt(id, reprocessBatchId);
    } catch (error) {
      if (!(error instanceof EventChanged) || attempt >= 2) throw error;
    }
  }
}
async function processArticleAttempt(id: string, reprocessBatchId?: string) {
  const [article] = await db.select().from(articles).where(eq(articles.id, id));
  if (!article || article.state !== 'pending') return;
  const config = await getSettings();
  const [source] = article.sourceId
    ? await db.select().from(sources).where(eq(sources.id, article.sourceId))
    : [];
  const industry = {
    id: 'ai',
    name: '数智参阅',
    description: config.editorialPrompt,
    sections: allowedSourceSections(
      source?.sections ?? [],
      fixedSections(config.sections).map((s) => s.name),
    ),
  };
  const sectionRules = fixedSections(config.sections).filter((s) =>
    industry.sections.includes(s.name),
  );
  const keywords = sectionRules.map((section) => `${section.name}：${section.keywords}`).join('\n');
  const connection = await getModelConnection();
  const subject = `article:${id}`;
  const runKey = fingerprint({
    version: PROCESS_VERSION,
    reprocessBatchId,
    endpoint: connection.baseUrl.replace(/\/+$/, ''),
    title: article.title,
    excerpt: article.excerpt,
    industry,
    sectionRules,
    ratingRules: config.ratingRules,
    keywords,
    prompt: config.editorialPrompt,
    model: connection.model,
    review: config.reviewEnabled,
    reviewModel: connection.model,
  });
  await stage(subject, runKey, 'validate', async () => {
    if (!article.title.trim() || !article.excerpt.trim()) throw new Error('材料缺少标题或摘要');
    return {
      title: article.title,
      source: article.sourceName,
      excerpt: article.excerpt,
      publishedAt: article.publishedAt,
      matchedKeywords: keywordMatches(article.title + ' ' + article.excerpt, keywords),
      version: PROCESS_VERSION,
      ratingRules: config.ratingRules,
      endpoint: connection.baseUrl.replace(/\/+$/, ''),
    };
  });
  const passages = sourcePassages(article.excerpt);
  const publicationAt = new Date(`${localDate(article.publishedAt)}T${config.dailyTime}:00+08:00`);
  const periodDate = localDate(
    new Date(publicationAt.getTime() + (article.publishedAt >= publicationAt ? 86400_000 : 0)),
  );
  const articleRange = rangeFor('daily', periodDate, config.dailyTime);
  const candidates = await stage(subject, runKey, 'recall', async () => {
    const recent = await db
      .select()
      .from(events)
      .where(
        and(
          isNotNull(events.assessment),
          gte(events.occurredAt, articleRange.start),
          lt(events.occurredAt, articleRange.end),
        ),
      )
      .orderBy(desc(events.updatedAt));
    return recent
      .map((e) => ({
        ...e,
        similarity: recallScore(article.title + ' ' + article.excerpt, e.title + ' ' + e.summary),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 12);
  });
  const decision = await stage(subject, runKey, 'analyze', async () => {
    const value = await modelJSON(
      'article',
      `你是数智参阅编辑。一次完成AI实质关联筛选、可配置指标评分、事实提取、中文标题摘要、本期事件归组。输入只有来源摘要，不得补写未提供事实。榜单快照按采集时点陈述，采集时间不是模型或项目发布时间；首次快照不能推断新上榜或排名升降。${config.editorialPrompt}
关键词仅用于召回线索，不能凭命中关键词收录，也不能漏掉不含这些词的重要AI内容。普通金融新闻和泛数字化不收。纯营销、没有实质事实、标题与材料不符或无法追溯来源的低质量材料输出relevant:false并给出具体原因；有真实新增事实的机构公告不因其机构自述身份直接淘汰。先检查来源与证据，再评分。${ratingInstructionsFor(config.ratingRules)}只使用给定栏目，按sectionRules的description判断归属，它们是该信源允许参与的栏目；不属于任何允许栏目时输出relevant:false并说明“超出信源栏目范围”，不能强行归类。section是单选栏目名。媒体传闻、匿名消息、厂商自述保留归属和不确定性。existingEventId只能是给定候选ID，同公司不代表同事件。facts逐项给出statement、evidenceIds、status(confirmed/announced/planned/claim/rumor)、entities；evidenceIds只能选择article.passages中的原文编号，例如["S1"]；每条最多引用4段。不要返回evidence或自行抄写原文，系统会按编号提取原文。事实陈述必须得到所选原文支持，保留预计、传闻和厂商自述等限定。仅选取最多12条核心事实，覆盖标题和摘要中的主要陈述；相近事实合并，不要逐句罗列全文，相关资讯至少一条事实；事实不足不要编造。不相关输出{"relevant":false,"reason":"具体原因"}。相关输出必须严格遵守此结构，scoreReason与assessment同级：{"relevant":true,"title":"中文标题","summary":"中文摘要","section":"单个栏目名","assessment":{"指标ID":{"score":1,"reason":"具体理由"}},"scoreReason":"评分总述","existingEventId":null,"facts":[{"statement":"事实陈述","evidenceIds":["S1"],"status":"announced","entities":[]}],"novelty":"new","newFactIndexes":[0],"needsReview":false,"conflict":false}。candidates仅包含本期事件。对照候选标题和摘要判断本期报道的事实增量；不判断跨期重复，未刊历史不能影响本篇相关性或评分。报道日期变新、换媒体、改写标题、重述融资金额和评级、泛泛风险评论均不构成新进展。facts保留本篇核心事实；newFactIndexes返回真正新增事实在facts中的零起始索引，排除历史背景与已知事实。没有新增事实必须引用旧事件并标duplicate，newFactIndexes为[]；有新增事实归入旧事件标update，只选新增事实索引。只有不同具体事项才能新建事件；不能因为报道增加背景或覆盖多家公司就把同一交易重新建档。重复报道标duplicate；有冲突或归属不确定标needsReview。合并新进展时summary保留重要前情。`,
      {
        industry,
        sectionRules,
        keywords,
        reportedAt: article.publishedPrecision === 'observed' ? undefined : article.publishedAt,
        observedAt: article.publishedPrecision === 'observed' ? article.publishedAt : undefined,
        matchedKeywords: keywordMatches(article.title + ' ' + article.excerpt, keywords),
        article: {
          title: article.title,
          passages,
          source: article.sourceName,
          publishedAt: article.publishedPrecision === 'observed' ? undefined : article.publishedAt,
          observedAt: article.publishedPrecision === 'observed' ? article.publishedAt : undefined,
          publishedPrecision: article.publishedPrecision,
          provenance: article.provenance,
        },
        candidates: candidates.map((e) => ({
          id: e.id,
          title: e.title,
          summary: e.summary.slice(0, 500),
        })),
      },
      decisionSchema(passages).superRefine((value, ctx) => {
        if (!value.relevant) return;
        const scoreCheck = assessmentFor(config.ratingRules).safeParse(value.assessment);
        if (!scoreCheck.success)
          ctx.addIssue({
            code: 'custom',
            message: scoreCheck.error.issues.map((i) => i.message).join('；'),
          });
        if (!industry.sections.includes(value.section))
          ctx.addIssue({ code: 'custom', message: '模型返回了未配置栏目' });
        if (value.existingEventId && !candidates.some((e) => e.id === value.existingEventId))
          ctx.addIssue({ code: 'custom', message: '模型返回了无效事件引用' });
        if (value.existingEventId && value.novelty !== 'duplicate' && !value.newFactIndexes)
          ctx.addIssue({
            code: 'custom',
            message: '后续进展必须返回newFactIndexes，明确指出本次新增事实',
          });
        if (value.newFactIndexes) {
          if (
            new Set(value.newFactIndexes).size !== value.newFactIndexes.length ||
            value.newFactIndexes.some((i) => i >= value.facts.length)
          )
            ctx.addIssue({ code: 'custom', message: '新增事实索引重复或超出facts范围' });
          if (
            value.existingEventId &&
            value.novelty !== 'duplicate' &&
            !value.newFactIndexes.length
          )
            ctx.addIssue({ code: 'custom', message: '无新增事实应标duplicate，不得创建新进展' });
          if (value.novelty === 'duplicate' && value.newFactIndexes.length)
            ctx.addIssue({ code: 'custom', message: '重复报道的newFactIndexes必须为空' });
        }
        if (!value.facts.length)
          ctx.addIssue({ code: 'custom', message: '相关资讯缺少可追溯事实' });
        if (value.novelty === 'duplicate' && !value.existingEventId)
          ctx.addIssue({ code: 'custom', message: '重复报道必须引用已有事件' });
      }),
      { subject },
    );
    if (value.relevant) {
      if (!industry.sections.includes(value.section)) throw new Error('模型返回了未配置栏目');
      if (value.existingEventId && !candidates.some((e) => e.id === value.existingEventId))
        throw new Error('模型返回了无效事件引用');
      if (value.novelty === 'duplicate' && !value.existingEventId)
        throw new Error('重复报道必须引用已有事件');
    }
    return value;
  });
  let target = decision.relevant ? decision.existingEventId : null;
  let reviewNote: string | null = null;
  let reviewRejected = false;
  if (
    decision.relevant &&
    config.reviewEnabled &&
    (decision.needsReview ||
      decision.conflict ||
      (target && candidates.find((e) => e.id === target)?.similarity === 0))
  ) {
    const review = await stage(subject, runKey, 'review', () =>
      modelJSON(
        'review',
        '独立复核归组与事实边界。仅使用输入材料。重点检查同事件是否有事实依据、传闻是否被写成事实、摘要有无证据外推。返回{approved:boolean,reason:string}。不确定时approved=false，保留独立事件待人工核对。',
        {
          article: {
            title: article.title,
            excerpt: article.excerpt,
            source: article.sourceName,
            url: article.url,
            publishedAt:
              article.publishedPrecision === 'observed' ? undefined : article.publishedAt,
            observedAt: article.publishedPrecision === 'observed' ? article.publishedAt : undefined,
            publishedPrecision: article.publishedPrecision,
          },
          decision,
          candidate: candidates.find((e) => e.id === target),
        },
        z.object({ approved: z.boolean(), reason: z.string().max(2000) }),
        { subject },
      ),
    );
    reviewNote = review.reason;
    if (!review.approved) {
      target = null;
      reviewRejected = true;
    }
  }
  try {
    await stage(subject, runKey, 'save', async () => {
      let savedEventId = target;
      await db.transaction(async (tx) => {
        // Serialize change IDs with the event write so a reconnect cursor cannot skip a late commit.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(76140503)`);
        const [locked] = await tx.select().from(articles).where(eq(articles.id, id)).for('update');
        if (locked.state !== 'pending') return;
        if (!decision.relevant) {
          await tx
            .update(articles)
            .set({
              state: 'ignored',
              processingVersion: PROCESS_VERSION,
              inputHash: runKey,
              reviewNote: decision.reason,
              eventId: null,
              assessment: null,
              facts: null,
              scoreReason: null,
            })
            .where(eq(articles.id, id));
          return;
        }
        let eventId = target;
        const facts = decision.facts.length
          ? decision.facts
          : [
              {
                statement: decision.title,
                evidence: article.excerpt,
                status: 'claim' as const,
                entities: [],
              },
            ];
        const developmentFacts =
          target && decision.newFactIndexes ? decision.newFactIndexes.map((i) => facts[i]) : facts;
        const factHash = fingerprint(
          developmentFacts
            .map((f) => ({
              statement: f.statement.replace(/[\s，。；、,.]/g, ''),
              status: f.status,
            }))
            .sort((a, b) => a.statement.localeCompare(b.statement)),
        );
        let changed = true;
        if (!eventId && !reviewRejected) {
          const matching = await tx.execute<{ id: string }>(sql`
          SELECT e.id FROM events e WHERE e.assessment IS NOT NULL AND e.occurred_at >= ${articleRange.start.toISOString()}::timestamptz AND e.occurred_at < ${articleRange.end.toISOString()}::timestamptz
          AND (e.title=${decision.title} OR EXISTS(
            SELECT 1 FROM event_developments d WHERE d.event_id=e.id AND d.fact_hash=${factHash}
          )) ORDER BY e.updated_at DESC LIMIT 1`);
          eventId = matching.rows[0]?.id ?? null;
        }
        if (!eventId) {
          const [event] = await tx
            .insert(events)
            .values({
              industryId: industry.id,
              title: reviewRejected ? article.title : decision.title,
              summary: reviewRejected ? article.excerpt : decision.summary,
              section: decision.section,
              score: reviewRejected
                ? 0
                : Math.round(weightedRating(decision.assessment, config.ratingRules) * 20),
              assessment: decision.assessment,
              tags: decision.tags,
              occurredAt: article.publishedAt,
            })
            .returning();
          eventId = event.id;
        } else {
          const previous = await tx.execute(
            sql`SELECT 1 FROM event_developments WHERE event_id=${eventId} AND fact_hash=${factHash}`,
          );
          changed = decision.novelty !== 'duplicate' && !previous.rows.length;
          if (changed) {
            const [old] = await tx.select().from(events).where(eq(events.id, eventId));
            const recalled = candidates.find((e) => e.id === eventId);
            if (!recalled || old.updatedAt.getTime() !== new Date(recalled.updatedAt).getTime())
              throw new EventChanged('并发更新了同一事件，自动重试时重新召回和归组');
            await tx
              .update(events)
              .set({
                title: decision.title,
                summary: decision.summary,
                section: decision.section,
                industryId: 'ai',
                score: Math.round(weightedRating(decision.assessment, config.ratingRules) * 20),
                assessment: decision.assessment,
                tags: decision.tags,
                occurredAt: new Date(
                  Math.max(new Date(old.occurredAt).getTime(), article.publishedAt.getTime()),
                ),
                updatedAt: new Date(),
              })
              .where(eq(events.id, eventId));
          }
        }
        savedEventId = eventId;
        await tx
          .update(articles)
          .set({
            state: 'processed',
            eventId,
            processingVersion: PROCESS_VERSION,
            inputHash: runKey,
            facts,
            assessment: decision.assessment,
            scoreReason: decision.scoreReason,
            reviewNote,
          })
          .where(eq(articles.id, id));
        if (reprocessBatchId && !reviewRejected && !changed) {
          // A replay may change editorial judgement without adding a new factual development.
          const editorial = {
            title: decision.title,
            summary: decision.summary,
            section: decision.section,
            score: Math.round(weightedRating(decision.assessment, config.ratingRules) * 20),
            assessment: decision.assessment,
            ratingRules: config.ratingRules,
            tags: decision.tags,
          };
          const refreshed = await tx.execute(
            sql`UPDATE event_developments SET editorial=${JSON.stringify(editorial)}::jsonb WHERE event_id=${eventId} AND article_id=${id}`,
          );
          const [current] = await tx.select().from(events).where(eq(events.id, eventId));
          if (refreshed.rowCount && article.publishedAt.getTime() >= current.occurredAt.getTime()) {
            await tx
              .update(events)
              .set({
                title: editorial.title,
                summary: editorial.summary,
                section: editorial.section,
                score: editorial.score,
                assessment: editorial.assessment,
                tags: editorial.tags,
                industryId: 'ai',
                updatedAt: new Date(),
              })
              .where(eq(events.id, eventId));
            await tx.execute(sql`INSERT INTO news_changes(event_id) VALUES(${eventId})`);
          }
        }
        if (changed) {
          const [snapshot] = await tx.select().from(events).where(eq(events.id, eventId));
          const editorial = {
            title: snapshot.title,
            summary: snapshot.summary,
            section: snapshot.section,
            score: snapshot.score,
            assessment: snapshot.assessment,
            ratingRules: config.ratingRules,
            tags: snapshot.tags,
          };
          await tx.execute(
            sql`INSERT INTO event_developments(event_id,article_id,fact_hash,facts,happened_at,editorial) VALUES(${eventId},${id},${factHash},${JSON.stringify(developmentFacts)}::jsonb,${article.publishedAt.toISOString()}::timestamptz,${JSON.stringify(editorial)}::jsonb) ON CONFLICT DO NOTHING`,
          );
          await tx.execute(sql`INSERT INTO news_changes(event_id) VALUES(${eventId})`);
        }
      });
      return { eventId: savedEventId, reviewNote, relevant: decision.relevant };
    });
  } catch (error) {
    if (error instanceof EventChanged) {
      await pool.query(
        "UPDATE processing_steps SET state='skipped' WHERE subject=$1 AND run_key=$2 AND stage IN ('recall','analyze','review')",
        [subject, runKey],
      );
    }
    throw error;
  }
}
