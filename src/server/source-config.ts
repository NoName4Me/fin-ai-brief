import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from './db.ts';
import { sources } from './schema.ts';
import { getSettings } from './settings.ts';
import { validateRemoteUrl } from './fetch.ts';
import { validateSourceAccess } from './source-access.ts';
import { validateHtmlSourceUrl } from './html-source.ts';
import { isAihotItemsUrl, validateAihotUrl } from './aihot.ts';

export const verificationLabels: Record<string, string> = {
  pending: '待验证',
  technical: '采集可用·待评估',
  approved: '已选用',
  failed: '验证未通过',
  held: '暂不选用',
};
export const sourceConfigSchema = z.object({
  name: z.string().trim().min(1).max(200),
  originAddress: z.string().trim().max(2000),
  url: z.url().max(2000).nullable(),
  format: z.enum(['rss', 'json', 'html', 'manual']),
  sections: z
    .array(z.string().trim().min(1).max(40))
    .max(30)
    .transform((v) => [...new Set(v)]),
  priority: z.enum(['P0', 'P1', 'P2']),
  verificationStatus: z.enum(['pending', 'technical', 'approved', 'failed', 'held']),
  verificationNote: z.string().trim().max(2000),
  notes: z.string().trim().max(4000),
  intervalMinutes: z.number().int().min(5).max(1440),
  autoInterval: z.boolean(),
  minIntervalMinutes: z.number().int().min(5).max(1440),
  maxIntervalMinutes: z.number().int().min(5).max(1440),
});
export function allowedSourceSections(configured: string[], all: string[]) {
  return configured.length ? all.filter((s) => configured.includes(s)) : all;
}
export function assertSourceCanEnable(source: {
  url: string | null;
  format: string;
  verificationStatus: string;
}) {
  if (!source.url || source.format === 'manual') throw new Error('请先配置可用的采集入口');
  if (source.verificationStatus !== 'approved')
    throw new Error('请先完成采集与内容评估，并在详情中标为“已选用”');
}
export async function saveSourceConfig(id: string | undefined, input: unknown) {
  const value = sourceConfigSchema.parse(input);
  const config = await getSettings();
  if (
    value.sections.some(
      (name) => !config.sections.some((s) => s.kind === 'fixed' && s.name === name),
    )
  )
    throw new Error('信源包含已删除或未配置的固定栏目，请刷新后重试');
  if (id) z.uuid().parse(id);
  const [previous] = id ? await db.select().from(sources).where(eq(sources.id, id)) : [];
  if (id && !previous) throw new Error('信源不存在');
  if (value.minIntervalMinutes > value.maxIntervalMinutes)
    throw new Error('最短间隔不能大于最长间隔');
  if (
    value.autoInterval &&
    (value.intervalMinutes < value.minIntervalMinutes ||
      value.intervalMinutes > value.maxIntervalMinutes)
  )
    throw new Error('自动模式的当前间隔必须处于最短、最长间隔之间');
  if (value.format !== 'manual' && !value.url) throw new Error('请选择待接入，或填写采集入口');
  if (value.url) {
    if (!previous || previous.url !== value.url) await validateRemoteUrl(value.url);
    validateSourceAccess({
      ...value,
      intervalMinutes: Math.min(value.intervalMinutes, value.minIntervalMinutes),
    });
    if (value.format === 'html') validateHtmlSourceUrl(value.url);
    if (value.format === 'json' && isAihotItemsUrl(value.url)) validateAihotUrl(value.url);
  }
  if (value.verificationStatus === 'approved') {
    assertSourceCanEnable(value);
    if (!value.verificationNote) throw new Error('选用信源时请记录采集与内容评估结论');
  }
  if (id) {
    z.uuid().parse(id);
    return db.transaction(async (tx) => {
      const [old] = await tx.select().from(sources).where(eq(sources.id, id)).for('update');
      if (!old) throw new Error('信源不存在');
      const endpointChanged = old.url !== value.url || old.format !== value.format;
      // Replacing an endpoint invalidates the previous verification and turns collection off.
      const status = endpointChanged ? 'pending' : value.verificationStatus;
      const enabled = old.enabled && !endpointChanged && status === 'approved';
      const [saved] = await tx
        .update(sources)
        .set({
          ...value,
          verificationStatus: status,
          enabled,
          verifiedAt:
            endpointChanged || status === 'pending'
              ? null
              : status !== old.verificationStatus || value.verificationNote !== old.verificationNote
                ? new Date()
                : old.verifiedAt,
          ...(endpointChanged
            ? { etag: null, nextFetchAt: null, lastError: null, verificationNote: '' }
            : {}),
        })
        .where(eq(sources.id, id))
        .returning();
      return saved;
    });
  }
  const [saved] = await db
    .insert(sources)
    .values({
      ...value,
      industryId: 'ai',
      enabled: false,
      verifiedAt: value.verificationStatus === 'pending' ? null : new Date(),
    })
    .returning();
  return saved;
}
export async function toggleSource(id: string, enabled: boolean) {
  z.uuid().parse(id);
  await db.transaction(async (tx) => {
    const [source] = await tx.select().from(sources).where(eq(sources.id, id)).for('update');
    if (!source) throw new Error('信源不存在');
    if (enabled) assertSourceCanEnable(source);
    await tx
      .update(sources)
      .set({ enabled, nextFetchAt: enabled ? null : source.nextFetchAt })
      .where(eq(sources.id, id));
  });
}
