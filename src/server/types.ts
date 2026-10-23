import { z } from 'zod';
export const kindSchema = z.enum(['daily', 'weekly', 'monthly']);
export type Kind = z.infer<typeof kindSchema>;
export const kindNames: Record<Kind, string> = { daily: '日报', weekly: '周报', monthly: '月报' };
export const provenanceSchema = z.object({
  itemId: z.string(),
  category: z.string(),
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
  emphasis: z.array(z.string().max(200)).max(12).optional(),
  sources: z.array(sourceRefSchema).min(1).max(30),
});
export const briefTitleSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => [...value].length <= 200, '本期标题不能超过200字');
export const briefContentSchema = z.object({
  title: briefTitleSchema,
  note: z.string().max(2000).optional(),
  overview: z.record(z.string(), z.string().max(2000)),
  rangeStart: z.iso.datetime(),
  rangeEnd: z.iso.datetime(),
  items: z.array(briefItemSchema).min(1).max(100),
});
export type BriefContent = z.infer<typeof briefContentSchema>;
export const settingsSchema = z.object({
  taskRetryLimit: z.number().int().min(0).max(3).default(1),
  processingConcurrency: z.number().int().min(1).max(20).default(3),
  collectionEnabled: z.boolean().default(false),
  briefTitleMaxLength: z.number().int().min(1).max(200).default(36),
  weeklyDay: z.number().int().min(0).max(6).default(1),
  monthlyDay: z.number().int().min(1).max(31).default(1),
  startDate: z.iso.date().default(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)),
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
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  taskRetryLimit: 1,
  processingConcurrency: 3,
  briefTitleMaxLength: 36,
  weeklyDay: 1,
  monthlyDay: 1,
  collectionEnabled: false,
  startDate: new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10),
  reviewEnabled: true,
  processingModel: '',
  reviewModel: '',
  briefModel: '',
  autoPublish: true,
  modelDailyLimit: 100,
  dailyTime: '08:00',
  dailyEnabled: true,
  weeklyEnabled: true,
  monthlyEnabled: true,
  maxItems: 16,
  minScore: 60,
  editorialPrompt:
    '关注金融监管、行业进展、相关报告和AI模型、平台、研究及应用。区分公告、计划、实测与已生效事实，避免日常行情、营销和无依据推测。',
};
