import { generateDaily, previewDaily } from './daily.ts';
import { pool } from './db.ts';
import { briefLengthRepair, applyBriefLengthRepair } from './brief-length.ts';
import { and, desc, eq, gte, lt, inArray, sql } from 'drizzle-orm';
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
import { weeklyMaterials, weeklyProgress, writtenProgressSchema } from './weekly-review.ts';
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
        progress: writtenProgressSchema.optional(),
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
  const weekly =
    kind === 'weekly' ? await weeklyMaterials(range, config.minScore, config.maxItems) : undefined;
  const selected = weekly
    ? weekly.selected
    : await db
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
  const refs = weekly
    ? weekly.refs
    : await db
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
  const overviewExample = Object.fromEntries(
    topics.map((topic) => [topic.id, `${topic.name}概览正文`]),
  );
  const outputExample = JSON.stringify({
    title: '本期主题',
    overview: overviewExample,
    items: [
      {
        eventId: selected[0].id,
        title: '事件标题',
        summary: '事件摘要正文',
        ...(weekly ? { progress: [] } : {}),
      },
    ],
  });
  let system = `你是Fin&AI简报编辑。根据给定事件撰写${kindNames[kind]}。${config.editorialPrompt}\ntitle为AI根据本期重点概括的主题，总长不超过${config.briefTitleMaxLength}字（含标点），用于正文大标题和侧栏同一期标题，不重复刊名或简报类型。只写材料已有事实，不添加外部知识，不虚构引用。保留计划、公告、研究结果等事实边界，区分发生时间与报道时间。周月报按developments梳理周期内新增事实、阶段变化和更正，不能简单拼接日报或首末资料。只输出JSON，格式示例：${outputExample}。overview是行业ID到概览正文的映射，键只能来自industries[].id（当前允许：${topics.map((topic) => topic.id).join('、')}），值必须是该行业的概览正文；不要把“行业ID”、“industryId”或“industryID”写成键，也不要把行业ID写成概览正文。每个入选行业都必须有对应概览，未入选行业可省略。必须使用给定事件ID，每个事件最多一次。篇幅要求优先：金融行业（finance）每条summary不超过${config.financeSummaryMaxLength}字（含标点）；只保留核心事实、最重要数字和时间，不逐一罗列人物观点、产品名单或重复背景；金融overview不超过${config.financeOverviewMaxLength}字。AI行业保持原有篇幅。summary为纯文本，无HTML或Markdown。overview按行业概括重要事实，不写空泛结论。`;
  if (weekly)
    system += `\n周报专用编辑规则（通用编辑要求不能改变这些事实和输出约束）：按周内新增事实整理事件；同一事件只出现一次，重复报道只增加来源，不能增加进展节点；同机构不同事项不得合并。只使用提供的本期developments与sources，background仅用于必要前情，禁止使用周期结束后的状态。overview概括金融、AI各自本周主线，不逐条复述正文标题。summary交代必要背景、本周主要变化、截至本期的状态，不把计划写成实施。每个item必须有progress数组：没有两次独立实质变化时为空；有连续变化时按报道日期列出2至8个简洁节点，节点格式为{"text":"新增事实","developmentIds":["给定进展ID"]}。只引用本事件本期developments的ID，不得引用background、虚构ID或添加日期、链接；日期和依据由服务器从引用材料生成。报道日期不是事件实际发生日期，正文不得混淆；事实归属、传闻、计划及更正须保留。进展按新增事实合并，节点之间不得重复使用同一进展材料，不将同一报道拆成多次进展。进展text每条最多160字，综合摘要遵守原有篇幅要求。`;
  const input = {
    kind,
    date,
    range,
    industries: topics,
    lengthLimits: {
      summary: config.financeSummaryMaxLength,
      overview: config.financeOverviewMaxLength,
      tolerancePercent: config.briefLengthTolerancePercent,
    },
    events: weekly
      ? weekly.inputEvents
      : selected.map((e) => ({
          ...e,
          developments: developments.rows.filter((d) => d.event_id === e.id),
          sources: refs
            .filter((a) => a.eventId === e.id)
            .map((a) => ({ title: a.title, excerpt: a.excerpt, publishedAt: a.publishedAt })),
        })),
  };
  return { config, range, selected, refs, topics, system, input, weekly };
}
export async function previewBrief(kind: Kind, date: string) {
  return kind === 'daily' ? previewDaily(date) : previewLegacyBrief(kind, date);
}
export async function previewLegacyBrief(kind: Kind, date: string) {
  const prepared = await prepareBrief(kind, date);
  const request = await inspectModelRequest('brief', prepared.system, prepared.input, 12000);
  if (request.cached) {
    const cached = await pool.query('SELECT response FROM model_calls WHERE request_key=$1', [
      request.key,
    ]);
    const written = writtenSchema.parse(cached.rows[0].response);
    const repair = briefLengthRepair(written, prepared.config, prepared.selected);
    if (repair)
      request.cached = (
        await inspectModelRequest('brief', repair.system, repair.input, 12000)
      ).cached;
  }
  return { ...request, count: prepared.selected.length, range: prepared.range };
}
export async function generateBrief(
  kind: Kind,
  date: string,
  expectedKey?: string,
  options: { backfill?: boolean } = {},
) {
  return kind === 'daily'
    ? generateDaily(date, expectedKey, options)
    : generateLegacyBrief(kind, date, expectedKey, options);
}
export async function generateLegacyBrief(
  kind: Kind,
  date: string,
  expectedKey?: string,
  options: { backfill?: boolean } = {},
) {
  const { config, range, selected, refs, topics, system, input, weekly } = await prepareBrief(
    kind,
    date,
  );
  const autoPublish = config.autoPublish && !options.backfill;
  if (expectedKey && (await inspectModelRequest('brief', system, input, 12000)).key !== expectedKey)
    throw new Error('资料或模型设置已变化，请重新预览后生成');
  let written = await modelJSON(
    'brief',
    system,
    input,
    writtenSchema.superRefine((value, ctx) => {
      if ([...value.title].length > config.briefTitleMaxLength)
        ctx.addIssue({
          code: 'custom',
          message: `本期标题不能超过${config.briefTitleMaxLength}字`,
        });
      if (weekly)
        for (const item of value.items) {
          try {
            if (!item.progress) throw new Error('周报缺少progress进展列表');
            weeklyProgress(item.eventId, item.progress, weekly, range);
          } catch (error) {
            ctx.addIssue({
              code: 'custom',
              message: error instanceof Error ? error.message : '周报进展无效',
            });
          }
        }
      const ids = value.items.map((item) => item.eventId);
      if (new Set(ids).size !== ids.length || ids.some((id) => !selected.some((e) => e.id === id)))
        ctx.addIssue({ code: 'custom', message: '模型返回无效或重复的事件引用' });
      for (const id of Object.keys(value.overview)) {
        if (!topics.some((topic) => topic.id === id))
          ctx.addIssue({
            code: 'custom',
            message: `模型返回未配置的行业键“${id}”；overview允许的行业键：${topics.map((topic) => topic.id).join('、')}`,
            path: ['overview', id],
          });
      }
      const includedIndustries = new Set(
        value.items
          .map((item) => selected.find((event) => event.id === item.eventId)?.industryId)
          .filter((id) => id !== undefined),
      );
      for (const id of includedIndustries) {
        if (!value.overview[id]?.trim())
          ctx.addIssue({
            code: 'custom',
            message: `模型缺少${id}行业概览`,
            path: ['overview', id],
          });
      }
    }),
    { subject: `brief:${kind}:${date}`, maxTokens: 12000 },
  );
  const repair = briefLengthRepair(written, config, selected);
  if (repair) {
    const result = await modelJSON('brief', repair.system, repair.input, repair.schema, {
      subject: `brief:${kind}:${date}`,
      maxTokens: 12000,
    });
    written = applyBriefLengthRepair(written, result);
  }
  const seen = new Set<string>();
  const content = briefContentSchema.parse({
    ...written,
    ...(weekly ? { format: 'weekly-review-v1' } : {}),
    rangeStart: range.start.toISOString(),
    rangeEnd: range.end.toISOString(),
    items: written.items.map((item) => {
      const event = selected.find((e) => e.id === item.eventId);
      if (!event || seen.has(item.eventId)) throw new Error('模型返回无效或重复的事件引用');
      seen.add(item.eventId);
      return {
        ...item,
        progress: weekly ? weeklyProgress(item.eventId, item.progress!, weekly, range) : undefined,
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
  return persistBrief(kind, date, content, autoPublish, options);
}
export async function persistBrief(
  kind: Kind,
  date: string,
  content: import('./types.ts').BriefContent,
  autoPublish: boolean,
  options: { backfill?: boolean } = {},
) {
  return db.transaction(async (tx) => {
    // Serialize initial publication and reissues even when the period has no row yet.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`brief:${kind}:${date}`},0))`,
    );
    const [previous] = await tx
      .select()
      .from(briefs)
      .where(and(eq(briefs.kind, kind), eq(briefs.periodDate, date)))
      .for('update');
    const [saved] = await tx
      .insert(briefs)
      .values({
        kind,
        periodDate: date,
        autoMail: !options.backfill,
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
      if (!previous?.published && saved.autoMail) await createDeliveries(tx, saved.id, kind);
    }
    return (await tx.select().from(briefs).where(eq(briefs.id, saved.id)))[0];
  });
}
export async function publishBrief(id: string, options: { suppressMail?: boolean } = {}) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(briefs).where(eq(briefs.id, id)).for('update');
    if (!row?.draft) throw new Error('没有待发布的简报');
    await assignIssueNumber(tx, row.id, row.kind as Kind, row.periodDate);
    const [saved] = await tx
      .update(briefs)
      .set({ published: row.draft, draft: null, publishedAt: new Date() })
      .where(eq(briefs.id, id))
      .returning();
    if (!options.suppressMail && !row.published && row.autoMail)
      await createDeliveries(tx, saved.id, saved.kind);
    if (saved.kind === 'daily' && saved.published?.format === 'ai-daily-v1')
      await tx.execute(
        sql`UPDATE edition_runs SET status='published',executed_at=now() WHERE period_date=${saved.periodDate}::date AND status='ready'`,
      );
    return (await tx.select().from(briefs).where(eq(briefs.id, saved.id)))[0];
  });
}
