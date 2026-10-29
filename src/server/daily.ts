import { admissionThreshold, budgetLimit } from './editorial-limits.ts';
import { highlightErrors } from './highlights.ts';
import { explainEditionRecord, fixedSectionOutcome } from './edition-status.ts';
import { z } from 'zod';
import { pool } from './db.ts';
import { getSettings } from './settings.ts';
import { rangeFor, localDate } from './periods.ts';
import { weeklyMaterials } from './weekly-review.ts';
import { assessmentSchema, ratingForEditorial, fixedSections, rotationRules } from './editorial.ts';
import { briefContentSchema, briefTitleSchema } from './types.ts';
import { modelJSON, inspectModelRequest } from './model.ts';
import { fingerprint } from './processing-log.ts';
import { persistBrief, PendingArticles } from './briefs.ts';
import { dailyLengthRepair } from './daily-length.ts';

const writtenSchema = z.object({
  title: briefTitleSchema,
  items: z
    .array(
      z.object({
        eventId: z.uuid(),
        title: z.string().min(1).max(200),
        summary: z.string().min(1).max(2000),
      }),
    )
    .max(50),
  highlights: z.array(z.object({ eventId: z.uuid(), text: z.string().min(1).max(3000) })).max(10),
  rotations: z
    .array(
      z.object({
        name: z.string(),
        text: z.string().trim().min(1).max(4500),
        eventIds: z.array(z.uuid()).min(1).max(20),
      }),
    )
    .max(30),
});
export async function recordEdition(
  date: string,
  section: string,
  status: string,
  candidates: number,
  selected: number,
  reason: string,
  details: unknown[] = [],
) {
  await pool.query(
    `INSERT INTO edition_runs(period_date,section,status,candidate_count,selected_count,reason,details)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(period_date,section) DO UPDATE SET
    status=excluded.status,candidate_count=excluded.candidate_count,selected_count=excluded.selected_count,
    reason=excluded.reason,details=excluded.details,executed_at=now()`,
    [date, section, status, candidates, selected, reason, JSON.stringify(details)],
  );
}
async function prepareDaily(date: string) {
  const config = await getSettings();
  const range = rangeFor('daily', date, config.dailyTime);
  if (range.end > new Date()) throw new Error('该期统计区间尚未结束');
  const unfinished = await pool.query(
    "SELECT 1 FROM articles WHERE state='pending' AND published_at >= $1 AND published_at < $2 LIMIT 1",
    [range.start, range.end],
  );
  if (unfinished.rows.length)
    throw new PendingArticles('统计时段内仍有资讯待处理，请处理完成后再生成');
  const sections = fixedSections(config.sections);
  const material = await weeklyMaterials(range, 0, 1000, config);
  // Only assessments saved with a development belong to that historical cutoff.
  const scored = material.selected.flatMap((event) => {
    const snapshot = event.editorial as { assessment?: unknown; tags?: string[] } | null;
    const parsed = assessmentSchema.safeParse(snapshot?.assessment);
    const rating = parsed.success ? ratingForEditorial(event.editorial, config.ratingRules) : null;
    if (rating === null) return [];
    return [{ ...event, rating, tags: snapshot?.tags ?? [] }];
  });
  const perSectionRatings = sections.flatMap((rule) =>
    scored
      .filter((e) => e.section === rule.name)
      .slice(0, rule.maxItems)
      .map((e) => e.rating),
  );
  const target = Math.min(
    config.maxItems,
    sections.reduce((n, rule) => n + rule.minItems, 0),
  );
  const candidateRating = admissionThreshold(
    config.candidateRating,
    perSectionRatings,
    target,
    config.ratingRelaxationEnabled,
    config.ratingRelaxationMaxDrop,
  );
  const rated = scored.filter((e) => e.rating >= candidateRating);
  const selected: typeof rated = [];
  for (const rule of sections)
    selected.push(...rated.filter((e) => e.section === rule.name).slice(0, rule.maxItems));
  selected.sort((a, b) => b.rating - a.rating || a.id.localeCompare(b.id));
  selected.splice(config.maxItems);
  const highlightRating = admissionThreshold(
    config.highlightRating,
    selected.map((e) => e.rating),
    config.highlightsMinItems,
    config.ratingRelaxationEnabled && config.highlightsEnabled && !config.highlightsDeleted,
    config.ratingRelaxationMaxDrop,
    candidateRating,
  );
  const rules = rotationRules(date, config.startDate, config.sections).map((r) => ({
    ...r,
    scheduled: r.scheduled && config.rotationsEnabled,
  }));
  const rotationMaterials = await Promise.all(
    rules.map(async (rule) => {
      if (!rule.scheduled) return { ...rule, materials: undefined };
      const start = new Date(range.end.getTime() - rule.days * 86400000);
      const materials = await weeklyMaterials(
        { start, end: range.end },
        candidateRating * 20,
        1000,
        config,
      );
      materials.selected = materials.selected
        .filter(
          (e) =>
            assessmentSchema.safeParse((e.editorial as { assessment?: unknown })?.assessment)
              .success,
        )
        .slice(0, 30);
      const ids = new Set(materials.selected.map((e) => e.id));
      materials.inputEvents = materials.inputEvents.filter((e) => ids.has(e.id));
      materials.refs = materials.refs.filter((a) => ids.has(a.eventId!));
      return { ...rule, materials };
    }),
  );
  const system = `你是数智参阅编辑。${config.editorialPrompt}榜单快照按采集时点陈述，不能当作模型或项目在当日发布；首次快照不推断排名变化。 只使用提供的材料，不添加外部事实或投资建议。区分计划、研究结果、机构自述与已证实事实。
输出{title,items:[{eventId,title,summary}],highlights:[{eventId,text}],rotations:[{name,text,eventIds}]}。
title不重复刊名，不添加“数智参阅｜”前缀，最多${config.briefTitleMaxLength}字。items必须覆盖给定当日selected事件且各一次，不增加或删除事件。每个栏目遵守其description。每个栏目内title+summary合计不得超过budget字。短刊允许少于条数目标，不凑稿。不强求行动建议。
highlights${config.highlightsEnabled && !config.highlightsDeleted ? `是“${config.highlightsName}”，只从当日items中rating>=${highlightRating}的事件选${config.highlightsMinItems}至${config.highlightsMaxItems}条，总计不超过${config.highlightsBudget}字。${config.highlightsPrompt}` : '已关闭，必须输出空数组'}。不足时少选，不凑条数。不得编造事件ID。
轮动只写scheduled=true且证据足够的栏目，参考每项keywords并遵守description及minItems/maxItems（引用不同事件数）和budget，正文不得超过budget字。资料不足时省略，不使用当日窗口之外的材料冒充当日新闻。引用对应rotationMaterials给定事件ID，所有事实、机构、数字和案例必须来自最终eventIds引用的材料；不要写入未引用事件或编造图表。所有正文纯文本。`;
  const input = {
    date,
    range,
    sections,
    ratingRules: config.ratingRules,
    candidateRating,
    highlightRating,
    highlights: {
      enabled: config.highlightsEnabled && !config.highlightsDeleted,
      name: config.highlightsName,
      minItems: config.highlightsMinItems,
      maxItems: config.highlightsMaxItems,
      budget: config.highlightsBudget,
      prompt: config.highlightsPrompt,
    },
    selected: selected.map((e) => ({
      id: e.id,
      section: e.section,
      rating: e.rating,
      materials: material.inputEvents.find((v) => v.id === e.id),
    })),
    rotationMaterials: rotationMaterials.map((r) => ({
      name: r.name,
      scheduled: r.scheduled,
      budget: r.budget,
      description: r.description,
      keywords: r.keywords,
      minItems: r.minItems,
      maxItems: r.maxItems,
      events: r.materials?.inputEvents ?? [],
    })),
  };
  const health = await pool.query(
    `SELECT
    (SELECT count(*)::int FROM articles WHERE state IN ('failed','pending') AND published_at >= $1 AND published_at < $2) AS processing_errors,
    (SELECT count(*)::int FROM sources WHERE enabled AND (last_error IS NOT NULL OR last_fetched_at IS NULL OR last_fetched_at < $2::timestamptz - (interval_minutes * 2) * interval '1 minute')) AS source_errors,
    (SELECT count(*)::int FROM articles WHERE state='processed' AND assessment IS NULL AND published_at >= $1 AND published_at < $2) AS unassessed`,
    [range.start, range.end],
  );
  return {
    config,
    candidateRating,
    highlightRating,
    health: health.rows[0] as {
      processing_errors: number;
      source_errors: number;
      unassessed: number;
    },
    sections,
    range,
    material,
    rated,
    selected,
    rotationMaterials,
    system,
    input,
    unhealthy:
      Number(health.rows[0].processing_errors) +
        Number(health.rows[0].source_errors) +
        Number(health.rows[0].unassessed) +
        material.unscored +
        Number(rotationMaterials.some((r) => r.materials?.unscored)) >
      0,
  };
}
export async function previewDaily(date: string) {
  const p = await prepareDaily(date);
  const hasMaterials =
    p.selected.length || p.rotationMaterials.some((r) => r.materials?.selected.length);
  const request = hasMaterials
    ? await inspectModelRequest('brief', p.system, p.input, 12000, p.config.budgetTolerancePercent)
    : { key: fingerprint(p.input), model: '无需生成', cached: true };
  if (hasMaterials && request.cached) {
    const { rows } = await pool.query('SELECT response FROM model_calls WHERE request_key=$1', [
      request.key,
    ]);
    const written = writtenSchema.parse(rows[0].response);
    const repair = dailyLengthRepair(
      written.items,
      p.selected,
      p.sections,
      p.config.budgetTolerancePercent,
    );
    if (repair)
      request.cached = (
        await inspectModelRequest(
          'brief',
          repair.system,
          repair.input,
          12000,
          p.config.budgetTolerancePercent,
        )
      ).cached;
  }
  return { ...request, count: p.selected.length, range: p.range };
}
export async function generateDaily(
  date: string,
  expectedKey?: string,
  options: { backfill?: boolean } = {},
) {
  const config = await getSettings();
  const names = [
    ...fixedSections(config.sections).map((s) => s.name),
    ...rotationRules(date, config.startDate, config.sections).map((s) => s.name),
  ];
  let prepared: Awaited<ReturnType<typeof prepareDaily>> | undefined;
  try {
    const p = (prepared = await prepareDaily(date));
    if (!p.selected.length && p.material.unscored)
      throw new Error('候选资讯缺少当前启用指标的评分，请先重新处理资讯');
    if (!p.selected.length && p.unhealthy)
      throw new Error('本期暂无可发布资讯，采集、处理或旧资料评分存在异常，请查看任务记录');
    const hasMaterials =
      p.selected.length || p.rotationMaterials.some((r) => r.materials?.selected.length);
    const key = hasMaterials
      ? (
          await inspectModelRequest(
            'brief',
            p.system,
            p.input,
            12000,
            p.config.budgetTolerancePercent,
          )
        ).key
      : fingerprint(p.input);
    if (expectedKey && key !== expectedKey)
      throw new Error('资料或模型设置已变化，请重新预览后生成');
    const validation = writtenSchema.superRefine((v, ctx) => {
      const ids = v.items.map((i) => i.eventId);
      const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
      if ([...v.title].length > p.config.briefTitleMaxLength)
        fail(`本期标题不能超过${p.config.briefTitleMaxLength}字`);
      if (
        ids.length !== p.selected.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !p.selected.some((e) => e.id === id))
      )
        fail('模型返回无效或重复的事件引用，或遗漏已选事件');
      for (const message of highlightErrors(v.highlights, p.config)) fail(message);
      const highlightIds = v.highlights.map((h) => h.eventId);
      if (
        new Set(highlightIds).size !== highlightIds.length ||
        v.highlights.some(
          (h) => !p.selected.some((e) => e.id === h.eventId && e.rating >= p.highlightRating),
        )
      )
        fail('要览引用了未入选或评分不足的事件');
      if (new Set(v.rotations.map((r) => r.name)).size !== v.rotations.length) fail('轮动栏目重复');
      for (const r of v.rotations) {
        const source = p.rotationMaterials.find((s) => s.name === r.name && s.scheduled);
        if (
          !source ||
          [...r.text].length > budgetLimit(source.budget, p.config.budgetTolerancePercent) ||
          new Set(r.eventIds).size !== r.eventIds.length ||
          r.eventIds.some(
            (id) =>
              !source.materials?.selected.some(
                (e) =>
                  e.id === id &&
                  assessmentSchema.safeParse((e.editorial as { assessment?: unknown })?.assessment)
                    .success,
              ),
          )
        )
          fail('轮动引用无效、未排期或超过字数预算');
        if (source && (r.eventIds.length < source.minItems || r.eventIds.length > source.maxItems))
          fail(`${r.name}引用事件数不符合栏目配置`);
      }
    });
    let written = hasMaterials
      ? await modelJSON('brief', p.system, p.input, validation, {
          subject: `brief:daily:${date}`,
          maxTokens: 12000,
          validationContext: p.config.budgetTolerancePercent,
        })
      : { title: '数智参阅', items: [], highlights: [], rotations: [] };
    const repair = dailyLengthRepair(
      written.items,
      p.selected,
      p.sections,
      p.config.budgetTolerancePercent,
    );
    if (repair) {
      const result = await modelJSON('brief', repair.system, repair.input, repair.schema, {
        subject: `brief:daily:${date}`,
        maxTokens: 12000,
        validationContext: p.config.budgetTolerancePercent,
      });
      const replacement = new Map(result.items.map((i) => [i.eventId, i]));
      written = { ...written, items: written.items.map((i) => replacement.get(i.eventId) ?? i) };
      validation.parse(written);
    }
    const sourceRef = (a: (typeof p.material.refs)[number]) => ({
      title: a.title,
      name: a.sourceName,
      url: a.url,
      publishedAt:
        a.publishedPrecision === 'day' ? localDate(a.publishedAt) : a.publishedAt.toISOString(),
      provenance: a.provenance ?? undefined,
      ...(a.publishedPrecision === 'observed'
        ? { timeNote: '榜单快照采集时间，非项目或模型发布时间' }
        : {}),
    });
    const content = briefContentSchema.parse({
      ...written,
      format: 'ai-daily-v1',
      highlightsTitle: p.config.highlightsName,
      sectionOrder: p.config.sections.filter((s) => s.enabled).map((s) => s.name),
      overview: {},
      rangeStart: p.range.start.toISOString(),
      rangeEnd: p.range.end.toISOString(),
      note:
        !written.items.length && !written.rotations.length
          ? p.unhealthy
            ? '本期暂无可发布资讯，采集或处理存在异常。'
            : '本期暂无符合选题标准的资讯。'
          : undefined,
      highlights: written.highlights.map((h) => ({
        ...h,
        rating: p.selected.find((e) => e.id === h.eventId)!.rating,
      })),
      items: [...written.items]
        .sort(
          (a, b) =>
            p.sections.findIndex(
              (s) => s.name === p.selected.find((e) => e.id === a.eventId)?.section,
            ) -
            p.sections.findIndex(
              (s) => s.name === p.selected.find((e) => e.id === b.eventId)?.section,
            ),
        )
        .map((i) => {
          const event = p.selected.find((e) => e.id === i.eventId)!;
          return {
            ...i,
            industryId: 'ai',
            section: event.section,
            rating: event.rating,
            tags: event.tags,
            sources: p.material.refs.filter((a) => a.eventId === event.id).map(sourceRef),
          };
        }),
      rotations: written.rotations.map((r) => {
        const source = p.rotationMaterials.find((s) => s.name === r.name)!;
        return {
          name: r.name,
          text: r.text,
          sources: source
            .materials!.refs.filter((a) => r.eventIds.includes(a.eventId!))
            .map(sourceRef),
        };
      }),
    });
    const autoPublish = p.config.autoPublish && !options.backfill;
    const saved = await persistBrief('daily', date, content, autoPublish, options);
    const candidateDetails = (events: typeof p.material.selected, ids: string[]) =>
      events.map((event) => {
        const parsed = assessmentSchema.safeParse(
          (event.editorial as { assessment?: unknown })?.assessment,
        );
        const rating = parsed.success
          ? ratingForEditorial(event.editorial, p.config.ratingRules)
          : null;
        const selected = ids.includes(event.id);
        return {
          id: event.id,
          title: event.title,
          rating,
          assessment: parsed.success ? parsed.data : null,
          ratingRules: p.config.ratingRules,
          selected,
          reason: selected
            ? '本期采用'
            : rating === null
              ? '缺少启用指标评分，请重新处理资讯'
              : rating < p.candidateRating
                ? '未达到入选分数'
                : '未进入本期篇幅或材料不足以形成轮动内容',
        };
      });
    for (const rule of p.sections) {
      const count = content.items.filter((i) => i.section === rule.name).length;
      const candidates = [...p.material.selected, ...p.material.unscoredEvents].filter(
        (e) => e.section === rule.name,
      ).length;
      const qualified = p.rated.filter((e) => e.section === rule.name).length;
      const outcome = fixedSectionOutcome({
        candidates,
        qualified,
        selected: count,
        unscored: p.material.unscoredEvents.filter((e) => e.section === rule.name).length,
        published: autoPublish,
        health: p.health,
      });
      await recordEdition(
        date,
        rule.name,
        outcome.status,
        candidates,
        count,
        outcome.reason +
          (p.candidateRating < p.config.candidateRating
            ? `；内容不足，本次候选门槛由${p.config.candidateRating}放宽至${p.candidateRating}`
            : ''),
        candidateDetails(
          [...p.material.selected, ...p.material.unscoredEvents].filter(
            (e) => e.section === rule.name,
          ),
          content.items.map((i) => i.eventId),
        ),
      );
    }
    for (const rule of p.rotationMaterials) {
      const count = content.rotations?.find((r) => r.name === rule.name) ? 1 : 0;
      await recordEdition(
        date,
        rule.name,
        !rule.scheduled
          ? 'unscheduled'
          : count
            ? autoPublish
              ? 'published'
              : 'ready'
            : p.unhealthy
              ? 'error'
              : 'skipped',
        rule.materials?.selected.length ?? 0,
        count,
        !rule.scheduled
          ? '本期未排期或已关闭'
          : count
            ? '材料支持，已生成'
            : p.unhealthy
              ? '采集或处理存在异常，轮动材料可能不完整'
              : '材料不足以形成有依据的综合、案例或摘编',
        candidateDetails(
          rule.materials?.selected ?? [],
          written.rotations.find((r) => r.name === rule.name)?.eventIds ?? [],
        ),
      );
    }
    return saved;
  } catch (error) {
    const rotations = rotationRules(date, config.startDate, config.sections);
    for (const name of names) {
      const rotation = rotations.find((r) => r.name === name);
      const unscheduled = rotation && (!rotation.scheduled || !config.rotationsEnabled);
      const candidates = prepared
        ? rotation
          ? (prepared.rotationMaterials.find((r) => r.name === name)?.materials?.selected ?? [])
          : [...prepared.material.selected, ...prepared.material.unscoredEvents].filter(
              (e) => e.section === name,
            )
        : [];
      const failure = explainEditionRecord({
        section: name,
        status: unscheduled ? 'unscheduled' : 'error',
        candidate_count: candidates.length,
        selected_count: 0,
        reason: unscheduled
          ? '本期未排期或已关闭'
          : error instanceof Error
            ? error.message
            : '生成异常',
      });
      await recordEdition(
        date,
        name,
        failure.status,
        candidates.length,
        0,
        failure.reason,
        candidates.map((event) => {
          const parsed = assessmentSchema.safeParse(
            (event.editorial as { assessment?: unknown })?.assessment,
          );
          return {
            id: event.id,
            title: event.title,
            rating: parsed.success ? ratingForEditorial(event.editorial, config.ratingRules) : null,
            assessment: parsed.success ? parsed.data : null,
            ratingRules: config.ratingRules,
            selected: false,
            reason: '整期生成未完成，尚未刊登',
          };
        }),
      );
    }
    throw error;
  }
}
