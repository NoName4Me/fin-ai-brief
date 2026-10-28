import { z } from 'zod';

export const sectionRuleSchema = z
  .object({
    id: z.string().trim().min(1).max(100).optional(),
    name: z.string().trim().min(1).max(40),
    aliases: z.array(z.string().min(1).max(40)).max(100).default([]),
    kind: z.enum(['fixed', 'rotation']).default('fixed'),
    enabled: z.boolean().default(true),
    description: z.string().trim().max(2000).default(''),
    keywords: z.string().trim().max(2000).default(''),
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
export const defaultColumnDescriptions: Record<string, string> = {
  政策与监管:
    '回答AI相关的监管红线、鼓励方向与报备要求。优先依据监管部门正式文件，明确发文机构、适用范围、生效时间及实际变化，宁缺毋滥。写明“我司需关注”的事项，必须以材料为据，不虚构公司现状或具体适用义务。',
  技术与模型:
    '关注模型、工具与开源的实质变化，回答哪些变化会影响AI研发、部署、采购或使用。突出能力、成本、可靠性和使用条件，不堆参数与跑分；只写材料能够支持的实际影响。',
  同业与场景:
    '关注银行、券商、保险与AMC的AI落地案例，说明谁做成了什么、如何实施、效果证据与适用条件。每条给出有依据的“可借鉴点”；仅在已提供内部场景资料时对应二期场景，不虚构内部规划或成效。',
  资本与项目:
    '关注AI资金流向、项目合作、采购与招投标线索，说明相关主体、金额、项目阶段、采购需求及公开时间节点。作为采购线索池，对有依据的方案或案例标注“可参照”，不把意向、签约或宣传当作已交付成果。',
  风险与安全:
    '关注AI相关事故、监管处罚、诈骗与安全漏洞，回答发生了什么、涉及谁、如何防范。采用“避坑”的表达，说明风险条件、影响边界及材料支持的防范措施；有依据的要求可整理为上线审查清单素材。',
  工具与开源:
    '关注可直接使用的AI工具与开源项目，回答用途、适用条件以及能否私有化部署。核实许可、依赖、部署要求与限制，服务选型和POC；仅在证据充分时给出“值得试／暂不试”及理由，不凭宣传或热度推荐。',
  内部动态:
    '依据经过审批的内部供稿与平台使用数据，说明目前进展、已完成工作和下一步安排。遵守披露边界与审批要求，不从外部新闻推断内部动态；没有获批材料时留空。',
};
export const defaultSections = [
  { name: '政策与监管', minItems: 1, maxItems: 3, budget: 250 },
  { name: '技术与模型', minItems: 2, maxItems: 4, budget: 350 },
  { name: '同业与场景', minItems: 2, maxItems: 4, budget: 400 },
  { name: '资本与项目', minItems: 1, maxItems: 3, budget: 250 },
  { name: '风险与安全', minItems: 1, maxItems: 2, budget: 150 },
  { name: '工具与开源', minItems: 1, maxItems: 3, budget: 200 },
].map((s) =>
  sectionRuleSchema.parse({ ...s, description: defaultColumnDescriptions[s.name] ?? '' }),
);
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
export const defaultInternalColumn = sectionRuleSchema.parse({
  name: '内部动态',
  kind: 'fixed',
  enabled: false,
  minItems: 1,
  maxItems: 3,
  budget: 200,
  description: defaultColumnDescriptions['内部动态'],
});
export const defaultColumns = [...defaultSections, defaultInternalColumn, ...defaultRotations];
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
  if (old.editorialConfigVersion === 1) return migrateColumnKeywords(old);
  const sections = Array.isArray(old.sections) ? old.sections : defaultSections;
  const candidateRating =
    old.candidateRating ??
    (typeof old.minScore === 'number' ? Math.max(1, old.minScore / 20) : 3.5);
  return migrateColumnKeywords({
    ...old,
    editorialConfigVersion: 1,
    candidateRating,
    highlightRating: old.highlightRating ?? Math.max(4.3, Number(candidateRating)),
    sections: [
      ...sections,
      ...defaultRotations.map((r) => ({
        ...r,
        enabled: old.rotationsEnabled !== false,
        anchorDate: typeof old.rotationAnchor === 'string' ? old.rotationAnchor : r.anchorDate,
      })),
    ],
  });
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
function migrateColumnKeywords(value: Record<string, unknown>) {
  if (!Array.isArray(value.sections)) return value;
  const raw = typeof value.keywords === 'string' ? value.keywords : defaultKeywords;
  const sections = [...value.sections];
  if (
    value.internalColumnInitialized !== true &&
    !sections.some(
      (s) =>
        s &&
        typeof s === 'object' &&
        (s.name === '内部动态' || (Array.isArray(s.aliases) && s.aliases.includes('内部动态'))),
    )
  )
    sections.push(defaultInternalColumn);
  const mapping: Record<string, string[]> = {
    政策监管: ['政策与监管'],
    技术模型: ['技术与模型'],
    智能体工程: ['技术与模型', '工具与开源'],
    金融同业: ['同业与场景'],
    资本项目: ['资本与项目'],
    招投标: ['同业与场景'],
    风险安全: ['风险与安全'],
  };
  const normalize = (name: string) => name.replace(/[与／/、\s]/g, '');
  return {
    ...value,
    internalColumnInitialized: true,
    sections: sections.map((input) => {
      if (!input || typeof input !== 'object') return input;
      const original = input as Record<string, unknown>;
      const knownNames = [
        original.name,
        ...(Array.isArray(original.aliases) ? original.aliases : []),
      ];
      const fallbackDescription =
        knownNames
          .map((name) => (typeof name === 'string' ? defaultColumnDescriptions[name] : undefined))
          .find(Boolean) ?? '';
      const section: Record<string, unknown> = {
        ...original,
        description:
          typeof original.description === 'string' && original.description.trim()
            ? original.description
            : fallbackDescription,
      };
      if (Object.hasOwn(section, 'keywords')) return section;
      if (section.kind === 'rotation') return { ...section, keywords: '' };
      const names = [
        section.name,
        ...(Array.isArray(section.aliases) ? section.aliases : []),
      ].filter((name): name is string => typeof name === 'string');
      const keywords = raw
        .split('\n')
        .filter((line) => {
          const parts = line.split(/[：:]/);
          if (parts.length < 2) return true;
          const label = parts[0].trim();
          const targets = mapping[label];
          if (targets) return targets.some((target) => names.includes(target));
          const matched = value.sections as Record<string, unknown>[];
          const hasMatch = matched.some((s) =>
            [s.name, ...(Array.isArray(s.aliases) ? s.aliases : [])].some(
              (name) => typeof name === 'string' && normalize(name) === normalize(label),
            ),
          );
          return !hasMatch || names.some((name) => normalize(name) === normalize(label));
        })
        .map((line) => line.split(/[：:]/).at(-1)?.trim() ?? '')
        .filter(Boolean)
        .join('；');
      return { ...section, keywords };
    }),
  };
}
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
  return `各启用指标1—5整数分，每项提供来自材料的具体理由。assessment使用以下固定ID作为键，值为{score,reason}。assessment中不得放入scoreReason或任何非指标键。scoreReason是assessment的同级字段，必须作为顶层字符串返回。仅评估启用指标。总分由服务器按归一化权重计算，不要自行计算总分。指标：${JSON.stringify(active.map((r) => ({ id: r.id, name: r.name, description: r.description, percent: r.share * 100 })))}。`;
}
export const ratingInstructions = ratingInstructionsFor(defaultRatingRules);
export function evidenceMatches(excerpt: string, evidence: string) {
  const normalize = (text: string) => text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
  const needle = normalize(evidence);
  return needle.length > 0 && normalize(excerpt).includes(needle);
}
export function rotationRules(
  date: string,
  startDate: string,
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
      const weeks = Math.floor((monday(date) - monday(startDate)) / (7 * 86400000));
      return {
        ...r,
        anchorDate: startDate,
        lookbackDays: r.intervalWeeks * 7,
        days: r.intervalWeeks * 7,
        scheduled:
          r.enabled &&
          date >= startDate &&
          r.weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay()) &&
          ((weeks % r.intervalWeeks) + r.intervalWeeks) % r.intervalWeeks === 0,
      };
    });
}
