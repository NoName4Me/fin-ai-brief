'use server';
import { cleanupRetention } from '../server/retention.ts';
import { requestManualDelivery } from '../server/manual-delivery.ts';
import { requireModelConfig } from '../server/model.ts';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, pool } from '../server/db.ts';
import { sources, industries } from '../server/schema.ts';
import { login, logout, requireAdmin } from '../server/auth.ts';
import { subscribe, unsubscribe, removeSubscription } from '../server/subscriptions.ts';
import { getSettings, saveSettings } from '../server/settings.ts';
import { enqueue } from '../server/queue.ts';
import { requestGeneration } from '../server/generation-requests.ts';
import { publishBrief } from '../server/briefs.ts';
import { importArticle } from '../server/collect.ts';
import { kindSchema } from '../server/types.ts';
import { rangeFor, validDate, backfillPeriods, localDate } from '../server/periods.ts';
import { retryArticle, retryJob, retryManagedTask } from '../server/admin-tasks.ts';
import { validateSourceAccess } from '../server/source-access.ts';
import { validateHtmlSourceUrl } from '../server/html-source.ts';
import { validateAihotUrl, isAihotItemsUrl } from '../server/aihot.ts';
import { validateRemoteUrl } from '../server/fetch.ts';
const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
async function perform(path: string, fn: () => Promise<unknown>, admin = true) {
  if (admin) await requireAdmin();
  let notice = '操作已完成';
  let failed = false;
  try {
    await fn();
    revalidatePath('/', 'layout');
  } catch (error) {
    failed = true;
    notice =
      error instanceof z.ZodError
        ? '输入有误，请检查必填项和格式'
        : error instanceof Error
          ? error.message
          : '操作失败';
  }
  redirect(
    `${path}?${failed ? 'error' : 'notice'}=${encodeURIComponent(notice)}&event=${crypto.randomUUID()}`,
  );
}
export async function loginAction(form: FormData) {
  let error = '';
  try {
    await login(String(form.get('password') ?? ''));
  } catch (e) {
    error = e instanceof Error ? e.message : '登录失败';
  }
  redirect(error ? `/login?error=${encodeURIComponent(error)}` : '/admin');
}
export async function logoutAction() {
  await logout();
  redirect('/login');
}
export async function sourceAction(form: FormData) {
  await perform('/admin/sources', async () => {
    const value = z
      .object({
        name: z.string().min(1).max(200),
        url: z.url().max(2000),
        industryId: z.string().min(1),
        format: z.enum(['rss', 'json', 'html']),
        intervalMinutes: z.number().int().min(5).max(1440),
        enabled: z.boolean(),
        autoInterval: z.boolean(),
        minIntervalMinutes: z.number().int().min(5).max(1440),
        maxIntervalMinutes: z.number().int().min(5).max(1440),
      })
      .parse({
        name: text(form, 'name'),
        url: text(form, 'url'),
        industryId: text(form, 'industryId'),
        format: text(form, 'format'),
        intervalMinutes: Number(text(form, 'intervalMinutes') || 30),
        enabled: form.has('enabled'),
        autoInterval: form.has('autoInterval'),
        minIntervalMinutes: Number(
          text(form, 'minIntervalMinutes') || text(form, 'intervalMinutes') || 30,
        ),
        maxIntervalMinutes: Number(
          text(form, 'maxIntervalMinutes') ||
            Math.max(240, Number(text(form, 'intervalMinutes') || 30)),
        ),
      });
    if (value.minIntervalMinutes > value.maxIntervalMinutes)
      throw new Error('最短间隔不能大于最长间隔');
    if (
      value.autoInterval &&
      (value.intervalMinutes < value.minIntervalMinutes ||
        value.intervalMinutes > value.maxIntervalMinutes)
    )
      throw new Error('自动模式的当前间隔必须处于最短、最长间隔之间');
    validateSourceAccess({
      ...value,
      intervalMinutes: Math.min(value.intervalMinutes, value.minIntervalMinutes),
    });
    await validateRemoteUrl(value.url);
    if (value.format === 'html') validateHtmlSourceUrl(value.url);
    if (value.format === 'json' && isAihotItemsUrl(value.url)) validateAihotUrl(value.url);
    const id = text(form, 'id');
    if (id) {
      z.uuid().parse(id);
      await db
        .update(sources)
        .set({ ...value, etag: null, nextFetchAt: null, lastError: null })
        .where(eq(sources.id, id));
    } else await db.insert(sources).values(value);
  });
}
export async function sourceRemoveAction(form: FormData) {
  await perform('/admin/sources', async () => {
    await db.delete(sources).where(eq(sources.id, z.uuid().parse(text(form, 'id'))));
  });
}
export async function collectAction(form: FormData) {
  await perform('/admin/sources', async () => {
    await enqueue(
      'collect',
      { id: z.uuid().parse(text(form, 'id')), manual: true },
      text(form, 'id'),
    );
  });
}
export async function industryAction(form: FormData) {
  await perform('/admin/industries', async () => {
    const value = z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
        name: z.string().min(1).max(40),
        description: z.string().min(1).max(2000),
        sections: z.array(z.string().min(1).max(40)).min(1).max(20),
        position: z.number().int().min(0).max(100),
      })
      .parse({
        id: text(form, 'id'),
        name: text(form, 'name'),
        description: text(form, 'description'),
        sections: text(form, 'sections')
          .split(/\n/)
          .map((s) => s.trim())
          .filter(Boolean),
        position: Number(text(form, 'position')),
      });
    await db
      .insert(industries)
      .values(value)
      .onConflictDoUpdate({ target: industries.id, set: value });
  });
}
export async function industryRemoveAction(form: FormData) {
  await perform('/admin/industries', async () => {
    const id = text(form, 'id');
    const used = await pool.query(
      'SELECT 1 FROM sources WHERE industry_id=$1 UNION ALL SELECT 1 FROM articles WHERE industry_id=$1 UNION ALL SELECT 1 FROM events WHERE industry_id=$1 LIMIT 1',
      [id],
    );
    if (used.rows.length) throw new Error('该行业已有信源或资讯，不能删除');
    await db.delete(industries).where(eq(industries.id, id));
  });
}
export async function settingsAction(form: FormData) {
  await perform('/admin/settings', async () =>
    saveSettings({
      ...(await getSettings()),
      taskRetryLimit: Number(text(form, 'taskRetryLimit') || 0),
      processingConcurrency: Number(text(form, 'processingConcurrency') || 3),
      autoPublish: form.has('autoPublish'),
      collectionEnabled: form.has('collectionEnabled'),
      briefTitleMaxLength: Number(text(form, 'briefTitleMaxLength') || 36),
      financeSummaryMaxLength: Number(text(form, 'financeSummaryMaxLength') || 140),
      financeOverviewMaxLength: Number(text(form, 'financeOverviewMaxLength') || 120),
      briefLengthTolerancePercent: Number(text(form, 'briefLengthTolerancePercent') || 10),
      weeklyDay: Number(text(form, 'weeklyDay') || 1),
      monthlyDay: Number(text(form, 'monthlyDay') || 1),
      startDate: text(form, 'startDate'),
      weeklyTime: text(form, 'weeklyTime'),
      monthlyTime: text(form, 'monthlyTime'),
      reviewEnabled: form.has('reviewEnabled'),
      processingModel: text(form, 'processingModel'),
      reviewModel: text(form, 'reviewModel'),
      briefModel: text(form, 'briefModel'),
      modelDailyLimit: Number(text(form, 'modelDailyLimit')),
      dailyTime: text(form, 'dailyTime'),
      dailyEnabled: form.has('dailyEnabled'),
      weeklyEnabled: form.has('weeklyEnabled'),
      monthlyEnabled: form.has('monthlyEnabled'),
      maxItems: Number(text(form, 'maxItems')),
      minScore: Number(text(form, 'minScore')),
      editorialPrompt: text(form, 'editorialPrompt'),
    }),
  );
}
export async function generateAction(form: FormData) {
  await perform('/admin', async () => {
    requireModelConfig();
    const kind = kindSchema.parse(text(form, 'kind'));
    const date = text(form, 'date');
    if (!validDate(date)) throw new Error('日期格式有误');
    const { getSettings } = await import('../server/settings.ts');
    const config = await getSettings();
    rangeFor(
      kind,
      date,
      kind === 'weekly'
        ? config.weeklyTime
        : kind === 'monthly'
          ? config.monthlyTime
          : config.dailyTime,
      config,
    );
    const force = form.get('force') === 'true';
    if (force && !form.has('confirmed')) throw new Error('请确认优先处理本期资讯后强制生成');
    const expectedKey = force
      ? undefined
      : z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(text(form, 'expectedKey'));
    await requestGeneration(kind, date, { force, expectedKey });
  });
}
export async function publishAction(form: FormData) {
  await perform('/admin', async () => {
    await publishBrief(z.uuid().parse(text(form, 'id')));
  });
}
export async function articleAction(form: FormData) {
  await perform('/admin/articles', async () => {
    const date = new Date(`${text(form, 'publishedAt')}:00+08:00`);
    if (Number.isNaN(date.getTime())) throw new Error('发布时间无效');
    await importArticle({
      title: text(form, 'title'),
      url: text(form, 'url'),
      excerpt: text(form, 'excerpt'),
      sourceName: text(form, 'sourceName'),
      industryId: text(form, 'industryId'),
      publishedAt: date.toISOString(),
    });
  });
}
export async function retryAction(form: FormData) {
  await perform('/admin/articles', async () => {
    const queue = z.enum(['collect', 'process', 'generate']).parse(text(form, 'queue'));
    const id = z.uuid().parse(text(form, 'id'));
    await retryJob(queue, id);
  });
}
export async function subscribeAction(form: FormData) {
  if (text(form, 'website')) redirect('/subscribe?registered=1');
  let token: string | null = null;
  let error = '';
  try {
    token = await subscribe({ email: text(form, 'email'), kinds: form.getAll('kinds') });
  } catch (e) {
    error =
      e instanceof z.ZodError
        ? '请输入有效邮箱，并选择至少一种简报'
        : e instanceof Error
          ? e.message
          : '登记失败';
  }
  redirect(
    error
      ? `/subscribe?error=${encodeURIComponent(error)}`
      : `/subscribe?registered=1${token ? `&token=${encodeURIComponent(token)}` : ''}`,
  );
}
export async function unsubscribeAction(form: FormData) {
  await perform('/unsubscribe', async () => unsubscribe(text(form, 'token')), false);
}
export async function removeSubscriberAction(form: FormData) {
  await perform('/admin/subscriptions', async () =>
    removeSubscription(z.uuid().parse(text(form, 'id'))),
  );
}

export async function retryArticleAction(form: FormData) {
  await perform('/admin/articles', () => retryArticle(text(form, 'id')));
}
export async function backfillAction(form: FormData) {
  await perform('/admin/settings', async () => {
    const { getSettings } = await import('../server/settings.ts');
    const config = await getSettings();
    const kind = kindSchema.parse(text(form, 'kind')),
      from = text(form, 'from'),
      to = text(form, 'to');
    if (!form.has('confirmed')) throw new Error('请先确认补刊期数和潜在调用量');
    if (from < config.startDate || to > localDate())
      throw new Error('补刊范围须在起刊日期与今天之间');
    const periods = backfillPeriods(from, to, kind, config);
    for (const period of periods) {
      const existing = await pool.query('SELECT 1 FROM briefs WHERE kind=$1 AND period_date=$2', [
        kind,
        period.date,
      ]);
      if (existing.rows.length) continue;
      const time =
        kind === 'weekly'
          ? config.weeklyTime
          : kind === 'monthly'
            ? config.monthlyTime
            : config.dailyTime;
      if (rangeFor(kind, period.date, time, config).end > new Date()) continue;
      await enqueue(
        'generate',
        { ...period, backfill: true, trigger: 'manual' },
        `${kind}:${period.date}`,
      );
    }
  });
}

export async function previewGenerateAction(form: FormData) {
  await requireAdmin();
  const kind = kindSchema.safeParse(text(form, 'kind')),
    date = text(form, 'date');
  if (!kind.success || !validDate(date))
    redirect('/admin?error=' + encodeURIComponent('类型或日期无效'));
  redirect('/admin?' + new URLSearchParams({ preview: '1', kind: kind.data, date }));
}

export async function retryManagedTaskAction(form: FormData) {
  await perform('/admin/articles', () => retryManagedTask(text(form, 'taskId')));
}

export async function manualDeliveryAction(form: FormData) {
  await requireAdmin();
  let message = '';
  let failed = false;
  try {
    const result = await requestManualDelivery({
      briefId: text(form, 'briefId'),
      subscriptionIds: form.getAll('subscriptionIds'),
      force: form.has('force'),
    });
    message = `已加入发送队列 ${result.created} 封${result.skipped ? `，跳过排队中、已发送或待核对的投递 ${result.skipped} 封` : ''}`;
    revalidatePath('/admin/subscriptions');
  } catch (error) {
    failed = true;
    message =
      error instanceof z.ZodError
        ? '请选择邮箱和已发布刊期'
        : error instanceof Error
          ? error.message
          : '推送失败';
  }
  redirect(
    `/admin/subscriptions?${failed ? 'error' : 'notice'}=${encodeURIComponent(message)}&event=${crypto.randomUUID()}`,
  );
}
export async function addSubscriberAction(form: FormData) {
  await perform('/admin/subscriptions', async () => {
    const token = await subscribe({ email: text(form, 'email'), kinds: form.getAll('kinds') });
    if (!token) throw new Error('该邮箱已有登记，请在名单中查看其订阅状态');
  });
}

export async function retentionSettingsAction(form: FormData) {
  await perform('/admin/retention', async () =>
    saveSettings({
      ...(await getSettings()),
      retentionEnabled: form.has('retentionEnabled'),
      newsRetentionDays: Number(text(form, 'newsRetentionDays')),
      taskRetentionDays: Number(text(form, 'taskRetentionDays')),
      mailRetentionDays: Number(text(form, 'mailRetentionDays')),
    }),
  );
}
export async function cleanupRetentionAction() {
  await requireAdmin();
  let notice = '',
    failed = false;
  try {
    const result = await cleanupRetention();
    notice = result.skipped
      ? '自动清理未开启，或已有清理任务正在执行'
      : `清理完成：资讯 ${result.counts.events ?? 0} 条，任务 ${result.counts.jobs ?? 0} 条，邮件记录 ${result.counts.deliveries ?? 0} 条`;
    revalidatePath('/', 'layout');
  } catch (error) {
    failed = true;
    notice = error instanceof Error ? error.message : '清理失败';
  }
  redirect(
    `/admin/retention?${failed ? 'error' : 'notice'}=${encodeURIComponent(notice)}&event=${crypto.randomUUID()}`,
  );
}
