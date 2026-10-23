import { pool } from './db.ts';
import { and, desc, eq, gte, lt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db.ts';
import { articles, briefs, events, industries } from './schema.ts';
import { getSettings } from './settings.ts';
import { modelJSON, inspectModelRequest } from './model.ts';
import { briefContentSchema, briefTitleSchema, kindNames, type Kind } from './types.ts';
import { localDate } from './periods.ts';
import { rangeFor } from './periods.ts';
import { assignIssueNumber } from './issue-number.ts';
import { createDeliveries } from './delivery-outbox.ts';
export class PendingArticles extends Error {}
const writtenSchema = z.object({
  title: briefTitleSchema,
  overview: z.record(z.string(), z.string().max(2000)),
  items: z
    .array(
      z.object({
        eventId: z.uuid(),
        title: z.string().min(1).max(200),
        summary: z.string().min(1).max(2000),
      }),
    )
    .min(1)
    .max(50),
});
async function prepareBrief(kind: Kind, date: string) {
  const config = await getSettings();
  const range = rangeFor(
    kind,
    date,
    kind === 'weekly'
      ? config.weeklyTime
      : kind === 'monthly'
        ? config.monthlyTime
        : config.dailyTime,
    config,
  );
  if (range.end > new Date()) throw new Error('该期统计区间尚未结束');
  const unfinished = await db
    .select({ id: articles.id })
    .from(articles)
    .where(
      and(
        eq(articles.state, 'pending'),
        gte(articles.publishedAt, range.start),
        lt(articles.publishedAt, range.end),
      ),
    )
    .limit(1);
  if (unfinished.length) throw new PendingArticles('统计时段内仍有资讯待处理，请处理完成后再生成');
  const selected = await db
    .select()
    .from(events)
    .where(
      and(
        gte(events.occurredAt, range.start),
        lt(events.occurredAt, range.end),
        gte(events.score, config.minScore),
      ),
    )
    .orderBy(desc(events.score), desc(events.occurredAt))
    .limit(config.maxItems);
  if (!selected.length) throw new Error('该时段没有达到选题标准的事件');
  const refs = await db
    .select()
    .from(articles)
    .where(
      and(
        inArray(
          articles.eventId,
          selected.map((e) => e.id),
        ),
        lt(articles.publishedAt, range.end),
        gte(articles.publishedAt, range.start),
      ),
    );
  const topics = await db.select().from(industries).orderBy(industries.position);
  const developments = await pool.query(
    'SELECT event_id,facts,happened_at FROM event_developments WHERE happened_at >= $1 AND happened_at < $2 ORDER BY happened_at',
    [range.start, range.end],
  );
  const system = `你是Fin&AI简报编辑。根据给定事件撰写${kindNames[kind]}。${config.editorialPrompt}\ntitle为AI根据本期重点概括的主题，总长不超过${config.briefTitleMaxLength}字（含标点），用于正文大标题和侧栏同一期标题，不重复刊名或简报类型。只写材料已有事实，不添加外部知识，不虚构引用。保留计划、公告、研究结果等事实边界，区分发生时间与报道时间。周月报按developments梳理周期内新增事实、阶段变化和更正，不能简单拼接日报或首末资料。只输出JSON：{title:string,overview:{行业ID:string},items:[{eventId:string,title:string,summary:string}]}。必须使用给定事件ID，每个事件最多一次。篇幅要求优先：金融行业（finance）每条summary约70—120字，绝不超过140字（含标点）；只保留核心事实、最重要数字和时间，不逐一罗列人物观点、产品名单或重复背景；金融overview不超过120字。AI行业保持原有篇幅。summary为纯文本，无HTML或Markdown。overview按行业概括重要事实，不写空泛结论。`;
  const input = {
    kind,
    date,
    range,
    industries: topics,
    events: selected.map((e) => ({
      ...e,
      developments: developments.rows.filter((d) => d.event_id === e.id),
      sources: refs
        .filter((a) => a.eventId === e.id)
        .map((a) => ({ title: a.title, excerpt: a.excerpt, publishedAt: a.publishedAt })),
    })),
  };
  return { config, range, selected, refs, topics, system, input };
}
export async function previewBrief(kind: Kind, date: string) {
  const prepared = await prepareBrief(kind, date);
  return {
    ...(await inspectModelRequest('brief', prepared.system, prepared.input, 12000)),
    count: prepared.selected.length,
    range: prepared.range,
  };
}
export async function generateBrief(kind: Kind, date: string, expectedKey?: string) {
  const { config, range, selected, refs, topics, system, input } = await prepareBrief(kind, date);
  const autoPublish = config.autoPublish;
  if (expectedKey && (await inspectModelRequest('brief', system, input, 12000)).key !== expectedKey)
    throw new Error('资料或模型设置已变化，请重新预览后生成');
  const written = await modelJSON(
    'brief',
    system,
    input,
    writtenSchema.superRefine((value, ctx) => {
      if ([...value.title].length > config.briefTitleMaxLength)
        ctx.addIssue({
          code: 'custom',
          message: `本期标题不能超过${config.briefTitleMaxLength}字`,
        });
      for (const item of value.items) {
        if (
          selected.find((e) => e.id === item.eventId)?.industryId === 'finance' &&
          [...item.summary].length > 140
        )
          ctx.addIssue({ code: 'custom', message: '金融摘要不能超过140字' });
      }
      if ([...(value.overview.finance ?? '')].length > 120)
        ctx.addIssue({ code: 'custom', message: '金融概览不能超过120字' });
      const ids = value.items.map((item) => item.eventId);
      if (new Set(ids).size !== ids.length || ids.some((id) => !selected.some((e) => e.id === id)))
        ctx.addIssue({ code: 'custom', message: '模型返回无效或重复的事件引用' });
      if (Object.keys(value.overview).some((id) => !topics.some((t) => t.id === id)))
        ctx.addIssue({ code: 'custom', message: '模型返回未配置的行业' });
    }),
    { subject: `brief:${kind}:${date}`, maxTokens: 12000 },
  );
  const seen = new Set<string>();
  const content = briefContentSchema.parse({
    ...written,
    rangeStart: range.start.toISOString(),
    rangeEnd: range.end.toISOString(),
    items: written.items.map((item) => {
      const event = selected.find((e) => e.id === item.eventId);
      if (!event || seen.has(item.eventId)) throw new Error('模型返回无效或重复的事件引用');
      seen.add(item.eventId);
      return {
        ...item,
        industryId: event.industryId,
        section: event.section,
        sources: refs
          .filter((a) => a.eventId === event.id)
          .map((a) => ({
            title: a.title,
            name: a.sourceName,
            provenance: a.provenance ?? undefined,
            url: a.url,
            publishedAt:
              a.publishedPrecision === 'day'
                ? localDate(a.publishedAt)
                : a.publishedAt.toISOString(),
          })),
      };
    }),
  });
  if (Object.keys(content.overview).some((id) => !topics.some((t) => t.id === id)))
    throw new Error('模型返回未配置的行业');
  return db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(briefs)
      .values({
        kind,
        periodDate: date,
        draft: autoPublish ? null : content,
        published: autoPublish ? content : null,
        generatedAt: new Date(),
        publishedAt: autoPublish ? new Date() : null,
      })
      .onConflictDoUpdate({
        target: [briefs.kind, briefs.periodDate],
        set: autoPublish
          ? { draft: null, published: content, generatedAt: new Date(), publishedAt: new Date() }
          : { draft: content, generatedAt: new Date() },
      })
      .returning();
    if (autoPublish) {
      await assignIssueNumber(tx, saved.id, kind, date);
      await createDeliveries(tx, saved.id, kind);
    }
    return (await tx.select().from(briefs).where(eq(briefs.id, saved.id)))[0];
  });
}
export async function publishBrief(id: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(briefs).where(eq(briefs.id, id)).for('update');
    if (!row?.draft) throw new Error('没有待发布的简报');
    await assignIssueNumber(tx, row.id, row.kind as Kind, row.periodDate);
    const [saved] = await tx
      .update(briefs)
      .set({ published: row.draft, draft: null, publishedAt: new Date() })
      .where(eq(briefs.id, id))
      .returning();
    await createDeliveries(tx, saved.id, saved.kind);
    return (await tx.select().from(briefs).where(eq(briefs.id, saved.id)))[0];
  });
}
