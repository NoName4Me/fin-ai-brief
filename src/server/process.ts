import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
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
  evidenceMatches,
} from './editorial.ts';
import { modelJSON } from './model.ts';
import { getSettings } from './settings.ts';
import { fingerprint, stage } from './processing-log.ts';
class EventChanged extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventChanged';
  }
}
export const PROCESS_VERSION = 'ai-editorial-v6';
const factSchema = z.object({
  statement: z.string().min(1).max(1000),
  evidence: z.string().min(1).max(2000),
  status: z.enum(['confirmed', 'announced', 'planned', 'claim', 'rumor']),
  entities: z.array(z.string().max(100)).max(20).default([]),
});
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
  facts: z.array(factSchema).max(12).default([]),
  novelty: z.enum(['new', 'update', 'duplicate']).default('new'),
  needsReview: z.boolean().default(false),
  conflict: z.boolean().default(false),
});
const decisionSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object' || (value as { relevant?: unknown }).relevant !== true)
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
export function recallScore(a: string, b: string) {
  const tokens = (s: string) =>
    new Set(s.toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2}/g) ?? []);
  const left = tokens(a),
    right = tokens(b);
  return [...left].filter((t) => right.has(t)).length;
}
export async function processArticle(id: string, reprocessBatchId?: string) {
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
  const subject = `article:${id}`;
  const runKey = fingerprint({
    version: PROCESS_VERSION,
    reprocessBatchId,
    endpoint: process.env.LLM_BASE_URL?.trim().replace(/\/+$/, ''),
    title: article.title,
    excerpt: article.excerpt,
    industry,
    sectionRules,
    ratingRules: config.ratingRules,
    keywords,
    prompt: config.editorialPrompt,
    model: config.processingModel || process.env.LLM_MODEL,
    review: config.reviewEnabled,
    reviewModel: config.reviewModel || process.env.LLM_MODEL,
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
      endpoint: process.env.LLM_BASE_URL?.trim().replace(/\/+$/, ''),
    };
  });
  const candidates = await stage(subject, runKey, 'recall', async () => {
    const recent = await db
      .select()
      .from(events)
      .where(
        and(
          isNotNull(events.assessment),
          gte(events.updatedAt, new Date(Date.now() - 14 * 86400_000)),
        ),
      )
      .orderBy(desc(events.updatedAt))
      .limit(80);
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
      `你是数智参阅编辑。一次完成AI实质关联筛选、可配置指标评分、事实提取、中文标题摘要、全局事件归组。输入只有来源摘要，不得补写未提供事实。榜单快照按采集时点陈述，采集时间不是模型或项目发布时间；首次快照不能推断新上榜或排名升降。${config.editorialPrompt}
关键词仅用于召回线索，不能凭命中关键词收录，也不能漏掉不含这些词的重要AI内容。普通金融新闻和泛数字化不收。纯营销、没有实质事实、标题与材料不符或无法追溯来源的低质量材料输出relevant:false并给出具体原因；有真实新增事实的机构公告不因其机构自述身份直接淘汰。先检查来源与证据，再评分。${ratingInstructionsFor(config.ratingRules)}只使用给定栏目，按sectionRules的description判断归属，它们是该信源允许参与的栏目；不属于任何允许栏目时输出relevant:false并说明“超出信源栏目范围”，不能强行归类。section是单选栏目名。媒体传闻、匿名消息、厂商自述保留归属和不确定性。existingEventId只能是给定候选ID，同公司不代表同事件。facts逐项给出statement、evidence、status(confirmed/announced/planned/claim/rumor)、entities；evidence必须逐字来自article.excerpt，但允许空白和标点的排版差异。最多12条，相关资讯至少一条事实；事实不足不要编造。不相关输出{"relevant":false,"reason":"具体原因"}。相关输出必须严格遵守此结构，scoreReason与assessment同级：{"relevant":true,"title":"中文标题","summary":"中文摘要","section":"单个栏目名","assessment":{"指标ID":{"score":1,"reason":"具体理由"}},"scoreReason":"评分总述","existingEventId":null,"facts":[{"statement":"事实陈述","evidence":"原文逐字片段","status":"announced","entities":[]}],"novelty":"new","needsReview":false,"conflict":false}。重复报道标duplicate；有冲突或归属不确定标needsReview。合并新进展时summary保留重要前情。`,
      {
        industry,
        sectionRules,
        keywords,
        reportedAt: article.publishedPrecision === 'observed' ? undefined : article.publishedAt,
        observedAt: article.publishedPrecision === 'observed' ? article.publishedAt : undefined,
        matchedKeywords: keywordMatches(article.title + ' ' + article.excerpt, keywords),
        article: {
          title: article.title,
          excerpt: article.excerpt,
          source: article.sourceName,
          publishedAt: article.publishedPrecision === 'observed' ? undefined : article.publishedAt,
          observedAt: article.publishedPrecision === 'observed' ? article.publishedAt : undefined,
          publishedPrecision: article.publishedPrecision,
          provenance: article.provenance,
        },
        candidates: candidates.map((e) => ({ id: e.id, title: e.title, summary: e.summary })),
      },
      decisionSchema.superRefine((value, ctx) => {
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
        for (const fact of value.facts)
          if (!evidenceMatches(article.excerpt, fact.evidence))
            ctx.addIssue({ code: 'custom', message: '模型事实依据不在来源摘要中' });
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
      for (const fact of value.facts)
        if (!evidenceMatches(article.excerpt, fact.evidence))
          throw new Error('模型事实依据不在来源摘要中');
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
        const factHash = fingerprint(
          facts
            .map((f) => ({
              statement: f.statement.replace(/[\s，。；、,.]/g, ''),
              status: f.status,
            }))
            .sort((a, b) => a.statement.localeCompare(b.statement)),
        );
        let changed = true;
        if (!eventId && !reviewRejected) {
          const matching = await tx.execute<{ id: string }>(sql`
          SELECT e.id FROM events e WHERE e.assessment IS NOT NULL AND e.updated_at >= now()-interval '14 days'
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
            sql`INSERT INTO event_developments(event_id,article_id,fact_hash,facts,happened_at,editorial) VALUES(${eventId},${id},${factHash},${JSON.stringify(facts)}::jsonb,${article.publishedAt.toISOString()}::timestamptz,${JSON.stringify(editorial)}::jsonb) ON CONFLICT DO NOTHING`,
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
