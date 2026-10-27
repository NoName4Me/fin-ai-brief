import { z } from 'zod';

export const sectionRuleSchema = z
  .object({
    id: z.string().trim().min(1).max(100).optional(),
    name: z.string().trim().min(1).max(40),
    aliases: z.array(z.string().min(1).max(40)).max(100).default([]),
    kind: z.enum(['fixed', 'rotation']).default('fixed'),
    enabled: z.boolean().default(true),
    description: z.string().trim().max(2000).default(''),
    minItems: z.number().int().min(0).max(20),
    maxItems: z.number().int().min(1).max(20),
    budget: z.number().int().min(50).max(3000),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1]),
    intervalWeeks: z.number().int().min(1).max(52).default(1),
    anchorDate: z.iso.date().default('2026-10-26'),
    lookbackDays: z.number().int().min(1).max(365).default(7),
  })
  .refine((v) => v.minItems <= v.maxItems, '条数下限不能高于上限')
  .transform((v) => ({ ...v, id: v.id ?? v.name }));
export type SectionRule = z.infer<typeof sectionRuleSchema>;
export const defaultSections = [
  { name: '政策与监管', minItems: 1, maxItems: 3, budget: 250 },
  { name: '技术与模型', minItems: 2, maxItems: 4, budget: 350 },
  { name: '同业与场景', minItems: 2, maxItems: 4, budget: 400 },
  { name: '资本与项目', minItems: 1, maxItems: 3, budget: 250 },
  { name: '风险与安全', minItems: 1, maxItems: 2, budget: 150 },
  { name: '工具与开源', minItems: 1, maxItems: 3, budget: 200 },
].map((s) => sectionRuleSchema.parse(s));
export const defaultRotations = [
  {
    name: '一周观察',
    weekdays: [1],
    intervalWeeks: 1,
    lookbackDays: 7,
    minItems: 3,
    maxItems: 5,
    budget: 500,
    description: '回顾过去一周3—5个不同事件，只在材料支持时提炼趋势。',
  },
  {
    name: '他山之石',
    weekdays: [3],
    intervalWeeks: 2,
    lookbackDays: 14,
    minItems: 1,
    maxItems: 5,
    budget: 400,
    description: '拆解一家同业或厂商的做法与条件，材料不足时跳过。',
  },
  {
    name: '数据一图／观点摘编',
    weekdays: [5],
    intervalWeeks: 1,
    lookbackDays: 7,
    minItems: 1,
    maxItems: 5,
    budget: 300,
    description: '一图一趋势或有出处的观点摘编，只使用可核对数字或归属明确的观点。',
  },
].map((s) => sectionRuleSchema.parse({ ...s, kind: 'rotation' }));
export const defaultColumns = [...defaultSections, ...defaultRotations];
export function fixedSections(sections: SectionRule[]) {
  return sections.filter((s) => s.kind === 'fixed' && s.enabled);
}
export function resolveSection(name: string, sections: SectionRule[]) {
  return sections.find((s) => s.name === name || s.aliases.includes(name))?.name ?? name;
}
export const ratingRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    name: z.string().trim().min(1).max(40),
    description: z.string().trim().min(1).max(2000),
    weight: z.number().min(0).max(100),
    enabled: z.boolean(),
  })
  .refine((r) => !r.enabled || r.weight > 0, '启用指标的权重必须大于0');
export type RatingRule = z.infer<typeof ratingRuleSchema>;
export const defaultRatingRules: RatingRule[] = [
  {
    id: 'relevance',
    name: '相关性',
    description: '与AI及目标读者的相关程度，不要求每条对应公司现有场景。',
    weight: 30,
    enabled: true,
  },
  {
    id: 'impact',
    name: '影响面',
    description: '对行业、机构或使用者产生影响的范围和程度。',
    weight: 20,
    enabled: true,
  },
  {
    id: 'timeliness',
    name: '时效性',
    description: '事件的新近程度以及当前关注和处理的必要性。',
    weight: 20,
    enabled: true,
  },
  {
    id: 'actionability',
    name: '可行动性',
    description:
      '具体可用参考价值：1分仅了解动态；3分有场景但条件或效果不足；5分方法、要求或案例明确且关键条件有依据。不假设公司资源需求，不因写一句建议而加分。',
    weight: 20,
    enabled: true,
  },
  {
    id: 'novelty',
    name: '信息增量',
    description: '相对已有信息，新增事实或独特信息贡献的程度。',
    weight: 10,
    enabled: true,
  },
];
export function normalizedRatingRules(rules: RatingRule[]) {
  const active = rules.filter((r) => r.enabled && r.weight > 0);
  const total = active.reduce((n, r) => n + r.weight, 0);
  return active.map((r) => ({ ...r, share: r.weight / total }));
}
// Upgrade existing JSON settings lazily; published editions are independent snapshots.
export function migrateEditorialSettings(input: unknown) {
  if (!input || typeof input !== 'object') return input;
  const old = input as Record<string, unknown>;
  if (old.editorialConfigVersion === 1) return old;
  const sections = Array.isArray(old.sections) ? old.sections : defaultSections;
  return {
    ...old,
    editorialConfigVersion: 1,
    candidateRating:
      old.candidateRating ?? (typeof old.minScore === 'number' ? old.minScore / 20 : 3.5),
    sections: [
      ...sections,
      ...defaultRotations.map((r) => ({
        ...r,
        enabled: old.rotationsEnabled !== false,
        anchorDate: typeof old.rotationAnchor === 'string' ? old.rotationAnchor : r.anchorDate,
      })),
    ],
  };
}
export const defaultKeywords = [
  '政策监管：生成式人工智能；算法备案；AI内容标识；数据安全；个人信息保护',
  '技术模型：大模型；多模态；推理成本；开源模型；模型评测',
  '智能体工程：智能体；AI Agent；MCP；RAG；知识库；上下文工程',
  '金融同业：金融AI；银行大模型；保险AI；智能投研；AMC AI；智能尽调',
  '资本项目：AI融资；AI并购；AI基金；特殊资产AI',
  '招投标：大模型招标；智能体中标；知识库采购；AI平台采购',
  '风险安全：AI安全；深度伪造；提示词注入；数据泄露；模型漏洞',
].join('\n');
export const aiScope =
  '只关注AI发展与治理，以及明确改变AI研发、部署、采购或使用条件的内容。金融、AMC是重点关注领域，涵盖监管、风险、资本、采购与应用；普通金融新闻、泛数字化和无法说明AI关联的内容不收录。';
const dimension = z.object({
  score: z.number().int().min(1).max(5),
  reason: z.string().trim().min(1).max(400),
});
export const assessmentSchema = z
  .record(z.string().min(1).max(64), dimension)
  .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 30, '评分项数量无效');
export function assessmentFor(rules: RatingRule[]) {
  const active = normalizedRatingRules(rules);
  return assessmentSchema.superRefine((value, ctx) => {
    for (const rule of active)
      if (!value[rule.id])
        ctx.addIssue({
          code: 'custom',
          message: `缺少启用指标「${rule.name}」的评分，请重新处理资讯`,
        });
  });
}
export type Assessment = z.infer<typeof assessmentSchema>;
export const editionRecordSchema = z.object({
  section: z.string(),
  status: z.string(),
  candidate_count: z.number(),
  selected_count: z.number(),
  reason: z.string(),
  details: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        rating: z.number().nullable(),
        assessment: assessmentSchema.nullable(),
        ratingRules: z.array(ratingRuleSchema).optional(),
        selected: z.boolean(),
        reason: z.string(),
      }),
    )
    .default([]),
});
export const weights = {
  relevance: 0.3,
  impact: 0.2,
  timeliness: 0.2,
  actionability: 0.2,
  novelty: 0.1,
} as const;
export function ratingFor(value: unknown, rules: RatingRule[] = defaultRatingRules): number | null {
  const parsed = assessmentFor(rules).safeParse(value);
  const active = normalizedRatingRules(rules);
  if (!parsed.success || !active.length) return null;
  return (
    Math.round(active.reduce((sum, r) => sum + parsed.data[r.id].score * r.share, 0) * 100) / 100
  );
}
export function ratingForEditorial(editorial: unknown, rules: RatingRule[]) {
  const snapshot = editorial as { assessment?: unknown; ratingRules?: RatingRule[] } | null;
  const previous = snapshot?.ratingRules ?? defaultRatingRules;
  if (
    rules.some(
      (r) =>
        r.enabled && !previous.some((old) => old.id === r.id && old.description === r.description),
    )
  )
    return null;
  return ratingFor(snapshot?.assessment, rules);
}
export function weightedRating(value: Assessment, rules: RatingRule[] = defaultRatingRules) {
  const score = ratingFor(value, rules);
  if (score === null) throw new Error('缺少启用指标的评分，请重新处理资讯');
  return score;
}
export function displayRating(score: number) {
  return Math.round(score * 2) / 2;
}
export function keywordMatches(text: string, groups: string) {
  const haystack = text.toLowerCase();
  return [
    ...new Set(
      groups
        .split('\n')
        .flatMap((line) => (line.split(/[：:]/).at(-1) ?? '').split(/[；;,，]/))
        .map((s) => s.trim())
        .filter((term) => term && haystack.includes(term.toLowerCase())),
    ),
  ];
}
export function ratingInstructionsFor(rules: RatingRule[]) {
  const active = normalizedRatingRules(rules);
  return `各启用指标1—5整数分，每项提供来自材料的具体理由。assessment使用以下固定ID作为键，值为{score,reason}。仅评估启用指标。总分由服务器按归一化权重计算，不要自行计算总分。指标：${JSON.stringify(active.map((r) => ({ id: r.id, name: r.name, description: r.description, percent: r.share * 100 })))}。`;
}
export const ratingInstructions = ratingInstructionsFor(defaultRatingRules);
export function rotationRules(
  date: string,
  anchor: string,
  sections: SectionRule[] = defaultColumns,
) {
  const monday = (value: string) => {
    const d = new Date(`${value}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.getTime();
  };
  return sections
    .filter((r) => r.kind === 'rotation')
    .map((r) => {
      const weeks = Math.floor(
        (monday(date) - monday(sections === defaultColumns ? anchor : r.anchorDate)) /
          (7 * 86400000),
      );
      return {
        ...r,
        days: r.lookbackDays,
        scheduled:
          r.enabled &&
          r.weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay()) &&
          ((weeks % r.intervalWeeks) + r.intervalWeeks) % r.intervalWeeks === 0,
      };
    });
}
