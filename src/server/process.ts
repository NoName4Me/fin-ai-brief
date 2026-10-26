import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, pool } from './db.ts';
import { articles, events, industries } from './schema.ts';
import { modelJSON } from './model.ts';
import { getSettings } from './settings.ts';
import { fingerprint, stage } from './processing-log.ts';
class EventChanged extends Error {}
export const PROCESS_VERSION = 'facts-v1';
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
  score: z.number().int().min(0).max(100),
  scoreReason: z.string().max(1000).default(''),
  existingEventId: z.uuid().nullable(),
  facts: z.array(factSchema).max(12).default([]),
  novelty: z.enum(['new', 'update', 'duplicate']).default('new'),
  needsReview: z.boolean().default(false),
  conflict: z.boolean().default(false),
});
const decisionSchema = z.discriminatedUnion('relevant', [
  selectedDecisionSchema,
  z.object({ relevant: z.literal(false), reason: z.string().max(1000).default('不属于本行业') }),
]);
export function recallScore(a: string, b: string) {
  const tokens = (s: string) =>
    new Set(s.toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2}/g) ?? []);
  const left = tokens(a),
    right = tokens(b);
  return [...left].filter((t) => right.has(t)).length;
}
export async function processArticle(id: string) {
  const [article] = await db.select().from(articles).where(eq(articles.id, id));
  if (!article || article.state !== 'pending') return;
  const [industry] = await db
    .select()
    .from(industries)
    .where(eq(industries.id, article.industryId));
  if (!industry) throw new Error('行业不存在');
  const config = await getSettings();
  const subject = `article:${id}`;
  const runKey = fingerprint({
    version: PROCESS_VERSION,
    endpoint: process.env.LLM_BASE_URL?.trim().replace(/\/+$/, ''),
    title: article.title,
    excerpt: article.excerpt,
    industry,
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
      version: PROCESS_VERSION,
      endpoint: process.env.LLM_BASE_URL?.trim().replace(/\/+$/, ''),
    };
  });
  const candidates = await stage(subject, runKey, 'recall', async () => {
    const recent = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.industryId, industry.id),
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
      `你是金融与AI资讯编辑。一次完成相关性筛选、重要性评分、事实提取、中文标题摘要和候选事件归组。输入只有来源摘要，不得补写未提供的事实。${config.editorialPrompt}
评分0—100考虑行业影响、事实新增量、来源可靠性、时效和相关性，并给出scoreReason。只使用给定栏目。媒体传闻、匿名消息、厂商自述保留归属和不确定性。existingEventId只能是给定候选ID，同公司不代表同事件。facts逐项给出statement、从article.excerpt逐字摘取的evidence、status(confirmed/announced/planned/claim/rumor)、entities。最多12条，相关资讯至少一条事实；事实不足不要编造。不相关输出{relevant:false,reason}。相关输出{relevant:true,title,summary,section,score,scoreReason,existingEventId,facts,novelty:new|update|duplicate,needsReview:boolean,conflict:boolean}。重复报道标duplicate；有冲突或归属不确定标needsReview。合并新进展时summary保留重要前情。`,
      {
        industry,
        article: {
          title: article.title,
          excerpt: article.excerpt,
          source: article.sourceName,
          publishedAt: article.publishedAt,
          provenance: article.provenance,
        },
        candidates: candidates.map((e) => ({ id: e.id, title: e.title, summary: e.summary })),
      },
      decisionSchema.superRefine((value, ctx) => {
        if (!value.relevant) return;
        if (!industry.sections.includes(value.section))
          ctx.addIssue({ code: 'custom', message: '模型返回了未配置栏目' });
        if (value.existingEventId && !candidates.some((e) => e.id === value.existingEventId))
          ctx.addIssue({ code: 'custom', message: '模型返回了无效事件引用' });
        for (const fact of value.facts)
          if (!article.excerpt.includes(fact.evidence))
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
        if (!article.excerpt.includes(fact.evidence)) throw new Error('模型事实依据不在来源摘要中');
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
          article: { title: article.title, excerpt: article.excerpt },
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
          SELECT e.id FROM events e WHERE e.industry_id=${industry.id}
          AND e.updated_at >= now()-interval '14 days'
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
              score: reviewRejected ? 0 : decision.score,
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
                score: decision.score,
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
            scoreReason: decision.scoreReason,
            reviewNote,
          })
          .where(eq(articles.id, id));
        if (changed) {
          const [snapshot] = await tx.select().from(events).where(eq(events.id, eventId));
          const editorial = {
            title: snapshot.title,
            summary: snapshot.summary,
            section: snapshot.section,
            score: snapshot.score,
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
