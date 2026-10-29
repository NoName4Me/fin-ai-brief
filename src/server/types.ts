import { z } from 'zod';
import { cleanBriefTitle } from './brief-title.ts';
import {
  aiScope,
  defaultKeywords,
  defaultColumns,
  defaultRatingRules,
  ratingRuleSchema,
  sectionRuleSchema,
  migrateEditorialSettings,
} from './editorial.ts';
export const kindSchema = z.enum(['daily', 'weekly', 'monthly']);
export type Kind = z.infer<typeof kindSchema>;
export const kindNames: Record<Kind, string> = { daily: '日报', weekly: '周报', monthly: '月报' };
export const rankingSnapshotSchema = z.object({
  boardUrl: z.url().refine((v) => /^https?:/.test(v)),
  observedAt: z.iso.datetime(),
  previousObservedAt: z.iso.datetime().optional(),
  entries: z
    .array(
      z.object({
        key: z.string().min(1).max(500),
        name: z.string().min(1).max(500),
        url: z.url().refine((v) => /^https?:/.test(v)),
        rank: z.number().int().positive(),
        score: z.number().finite().optional(),
        metric: z.string().max(200).optional(),
        description: z.string().max(1500).optional(),
      }),
    )
    .min(1)
    .max(1000),
});
export type RankingSnapshot = z.infer<typeof rankingSnapshotSchema>;
export const provenanceSchema = z.object({
  itemId: z.string(),
  category: z.string(),
  snapshot: rankingSnapshotSchema.optional(),
  attribution: z.object({ name: z.string(), url: z.url().refine((url) => /^https?:/.test(url)) }),
  canonical: z.url().refine((url) => /^https?:/.test(url)),
});
export type Provenance = z.infer<typeof provenanceSchema>;
export const sourceRefSchema = z.object({
  title: z.string().max(500),
  name: z.string().max(200),
  url: z.url().refine((v) => /^https?:/.test(v)),
  publishedAt: z.union([z.iso.datetime(), z.iso.date()]),
  provenance: provenanceSchema.optional(),
  timeNote: z.string().max(2000).optional(),
  detail: z.string().max(3000).optional(),
  announcementUrl: z
    .url()
    .refine((v) => /^https?:/.test(v))
    .optional(),
  timingIndexUrl: z
    .url()
    .refine((v) => /^https?:/.test(v))
    .optional(),
});
export const briefItemSchema = z.object({
  eventId: z.uuid(),
  industryId: z.string(),
  section: z.string().max(80),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  rating: z.number().min(1).max(5).optional(),
  tags: z.array(z.string().max(40)).max(12).optional(),
  progress: z
    .array(
      z.object({
        date: z.iso.date(),
        endDate: z.iso.date().optional(),
        text: z.string().min(1).max(500),
        sourceUrls: z.array(z.url()).min(1),
        evidence: z
          .array(
            z.object({
              sourceUrl: z.url(),
              statement: z.string(),
              excerpt: z.string(),
              status: z.string(),
            }),
          )
          .min(1),
      }),
    )
    .max(8)
    .optional(),
  emphasis: z.array(z.string().max(200)).max(12).optional(),
  sources: z.array(sourceRefSchema).min(1).max(200),
});
export const briefTitleSchema = z
  .string()
  .transform(cleanBriefTitle)
  .pipe(
    z
      .string()
      .trim()
      .min(1)
      .refine((value) => [...value].length <= 200, '本期标题不能超过200字'),
  );
export const briefContentSchema = z.object({
  format: z.enum(['weekly-review-v1', 'ai-daily-v1']).optional(),
  sectionOrder: z.array(z.string().max(40)).max(30).optional(),
  highlightsTitle: z.string().trim().min(1).max(40).optional(),
  highlights: z
    .array(
      z.object({
        eventId: z.uuid(),
        text: z.string().min(1).max(3000),
        rating: z.number().min(1).max(5),
      }),
    )
    .max(10)
    .optional(),
  rotations: z
    .array(
      z.object({ name: z.string(), text: z.string(), sources: z.array(sourceRefSchema).min(1) }),
    )
    .max(30)
    .optional(),
  title: briefTitleSchema,
  note: z.string().max(2000).optional(),
  overview: z.record(z.string(), z.string().max(2000)),
  rangeStart: z.iso.datetime(),
  rangeEnd: z.iso.datetime(),
  items: z.array(briefItemSchema).max(100),
});
export type BriefContent = z.infer<typeof briefContentSchema>;
export const settingsSchema = z.preprocess(
  (input) => {
    const migrated = migrateEditorialSettings(input);
    if (!migrated || typeof migrated !== 'object') return migrated;
    const value = migrated as Record<string, unknown>;
    return {
      ...value,
      highlightsMinItems:
        value.highlightsMinItems ?? Math.min(3, Number(value.highlightsMaxItems ?? 5)),
    };
  },
  z
    .object({
      editorialConfigVersion: z.literal(1).default(1),
      internalColumnInitialized: z.boolean().default(true),
      ratingRules: z
        .array(ratingRuleSchema)
        .min(1)
        .max(30)
        .default(defaultRatingRules)
        .refine((v) => v.some((r) => r.enabled && r.weight > 0), '至少启用一个评分指标')
        .refine((v) => new Set(v.map((r) => r.id)).size === v.length, '评分指标ID不能重复')
        .refine((v) => new Set(v.map((r) => r.name)).size === v.length, '评分指标名称不能重复'),
      candidateRating: z.number().min(1).max(5).default(3.5),
      highlightRating: z.number().min(1).max(5).default(4.3),
      ratingRelaxationEnabled: z.boolean().default(false),
      ratingRelaxationMaxDrop: z.number().min(0.1).max(1).default(0.3),
      budgetTolerancePercent: z.number().int().min(0).max(50).default(10),
      highlightsName: z.string().trim().min(1).max(40).default('今日要览'),
      highlightsDeleted: z.boolean().default(false),
      highlightsMinItems: z.number().int().min(0).max(10).default(3),
      highlightsEnabled: z.boolean().default(true),
      highlightsMaxItems: z.number().int().min(1).max(10).default(5),
      highlightsBudget: z.number().int().min(1).max(2000).default(150),
      highlightsPrompt: z
        .string()
        .max(2000)
        .default(
          '30秒读完今天最值得知道的事项，突出事实、影响与必要条件，不重复栏目标题，不增加材料之外的信息。',
        ),
      sections: z
        .array(sectionRuleSchema)
        .min(1)
        .max(30)
        .default(defaultColumns)
        .refine((v) => new Set(v.map((s) => s.name)).size === v.length, '栏目名不能重复')
        .refine((v) => new Set(v.map((s) => s.id)).size === v.length, '栏目ID不能重复')
        .refine((v) => v.some((s) => s.kind === 'fixed' && s.enabled), '至少保留一个启用的固定栏目')
        .refine(
          (v) =>
            v.every(
              (s) =>
                !s.aliases.some((a) =>
                  v.some(
                    (other) => other.id !== s.id && (other.name === a || other.aliases.includes(a)),
                  ),
                ),
            ),
          '栏目名称与历史名称冲突',
        ),
      // Read old settings without offering or generating new tags.
      tags: z.array(z.string().trim().min(1).max(40)).max(100).default([]),
      keywords: z.string().max(6000).default(defaultKeywords),
      rotationAnchor: z.iso.date().default('2026-10-26'),
      rotationsEnabled: z.boolean().default(true),
      retentionEnabled: z.boolean().default(true),
      newsRetentionDays: z.number().int().min(7).max(3650).default(30),
      taskRetentionDays: z.number().int().min(1).max(3650).default(30),
      mailRetentionDays: z.number().int().min(1).max(3650).default(7),
      taskRetryLimit: z.number().int().min(0).max(3).default(1),
      processingConcurrency: z.number().int().min(1).max(20).default(3),
      collectionEnabled: z.boolean().default(false),
      deliveryEnabled: z.boolean().default(true),
      financeSummaryMaxLength: z.number().int().min(1).max(1000).default(140),
      financeOverviewMaxLength: z.number().int().min(1).max(1000).default(120),
      briefLengthTolerancePercent: z.number().int().min(0).max(50).default(10),
      briefTitleMaxLength: z.number().int().min(1).max(200).default(36),
      weeklyDay: z.number().int().min(0).max(6).default(1),
      monthlyDay: z.number().int().min(1).max(31).default(1),
      startDate: z.iso
        .date()
        .default(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)),
      weeklyTime: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .optional(),
      monthlyTime: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .optional(),
      reviewEnabled: z.boolean().default(true),
      processingModel: z.string().max(200).default(''),
      reviewModel: z.string().max(200).default(''),
      briefModel: z.string().max(200).default(''),
      autoPublish: z.boolean(),
      modelDailyLimit: z.number().int().min(1).max(100000).default(100),
      dailyTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      dailyEnabled: z.boolean(),
      weeklyEnabled: z.boolean(),
      monthlyEnabled: z.boolean(),
      maxItems: z.number().int().min(2).max(50),
      minScore: z.number().int().min(0).max(100),
      editorialPrompt: z.string().max(6000),
    })
    .refine((v) => v.highlightRating >= v.candidateRating, '要览门槛不能低于日报候选门槛')
    .refine((v) => v.highlightsMinItems <= v.highlightsMaxItems, '要览条数下限不能大于上限')
    .refine(
      (v) => v.highlightsDeleted || !v.sections.some((s) => s.name === v.highlightsName),
      '栏目名称不能重复',
    )
    .transform((v) => ({
      ...v,
      rotationAnchor: v.startDate,
      sections: v.sections.map((s) =>
        s.kind === 'rotation'
          ? { ...s, anchorDate: v.startDate, lookbackDays: s.intervalWeeks * 7 }
          : s,
      ),
    })),
);
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  editorialConfigVersion: 1,
  internalColumnInitialized: true,
  sections: defaultColumns,
  ratingRules: defaultRatingRules,
  candidateRating: 3.5,
  highlightRating: 4.3,
  ratingRelaxationEnabled: false,
  ratingRelaxationMaxDrop: 0.3,
  budgetTolerancePercent: 10,
  highlightsName: '今日要览',
  highlightsDeleted: false,
  highlightsMinItems: 3,
  highlightsEnabled: true,
  highlightsMaxItems: 5,
  highlightsBudget: 150,
  highlightsPrompt:
    '30秒读完今天最值得知道的事项，突出事实、影响与必要条件，不重复栏目标题，不增加材料之外的信息。',
  tags: [],
  keywords: defaultKeywords,
  rotationAnchor: '2026-10-26',
  rotationsEnabled: true,
  retentionEnabled: true,
  newsRetentionDays: 30,
  taskRetentionDays: 30,
  mailRetentionDays: 7,
  taskRetryLimit: 1,
  processingConcurrency: 3,
  briefTitleMaxLength: 36,
  financeSummaryMaxLength: 140,
  financeOverviewMaxLength: 120,
  briefLengthTolerancePercent: 10,
  weeklyDay: 1,
  monthlyDay: 1,
  collectionEnabled: false,
  deliveryEnabled: true,
  startDate: new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10),
  reviewEnabled: true,
  processingModel: '',
  reviewModel: '',
  briefModel: '',
  autoPublish: true,
  modelDailyLimit: 100,
  dailyTime: '08:00',
  dailyEnabled: true,
  weeklyEnabled: false,
  monthlyEnabled: false,
  maxItems: 19,
  minScore: 70,
  editorialPrompt: aiScope,
};
