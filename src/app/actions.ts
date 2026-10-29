'use server';
import { requestSubscription } from '../server/subscription-confirmation.ts';
import { cleanupRetention } from '../server/retention.ts';
import { requestManualDelivery } from '../server/manual-delivery.ts';
import { requireModelConfig } from '../server/model.ts';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, pool } from '../server/db.ts';
import { sources } from '../server/schema.ts';
import { login, logout, requireAdmin } from '../server/auth.ts';
import { subscribe, unsubscribe, removeSubscription } from '../server/subscriptions.ts';
import { saveSettingsPatch, saveEditorialConfig } from '../server/settings.ts';
import { enqueue } from '../server/queue.ts';
import { requestGeneration } from '../server/generation-requests.ts';
import { publishBrief } from '../server/briefs.ts';
import { importArticle } from '../server/collect.ts';
import { kindSchema } from '../server/types.ts';

import { rangeFor, validDate, backfillPeriods, localDate } from '../server/periods.ts';
import { retryArticle, retryJob, retryManagedTask } from '../server/admin-tasks.ts';
import { requestReprocessing } from '../server/reprocessing.ts';
import { saveSourceConfig, toggleSource } from '../server/source-config.ts';
import { verifySource } from '../server/source-verification.ts';
const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
export async function reprocessRangeAction(form: FormData) {
  await requireAdmin();
  let batchId = '',
    message = '',
    failed = false;
  try {
    const result = await requestReprocessing({
      from: `${text(form, 'from')}:00+08:00`,
      to: `${text(form, 'to')}:00+08:00`,
      scope: text(form, 'scope'),
      regenerateDate: form.has('regenerate') ? text(form, 'regenerateDate') : undefined,
    });
    batchId = result.id;
    message = `已创建重新处理批次，共${result.total}条资讯`;
    revalidatePath('/admin/articles');
  } catch (error) {
    failed = true;
    message =
      error instanceof z.ZodError
        ? '请检查起止时间和日期'
        : error instanceof Error
          ? error.message
          : '创建批次失败';
  }
  redirect(
    `/admin/articles?${new URLSearchParams({ [failed ? 'error' : 'notice']: message, ...(batchId ? { batch: batchId } : {}), event: crypto.randomUUID() })}`,
  );
}
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
    `${path}${path.includes('?') ? '&' : '?'}${failed ? 'error' : 'notice'}=${encodeURIComponent(notice)}&event=${crypto.randomUUID()}`,
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
    const urls = (
      form.has('urls')
        ? text(form, 'urls')
        : [text(form, 'url'), text(form, 'additionalUrls')].join('\n')
    )
      .split(/\s+/)
      .filter(Boolean);
    await saveSourceConfig(text(form, 'id') || undefined, {
      name: text(form, 'name'),
      originAddress: text(form, 'originAddress'),
      url: urls[0] || null,
      additionalUrls: urls.slice(1),
      readDetails: form.has('readDetails'),
      format: text(form, 'format'),
      sections: form.getAll('sections').map(String),
      priority: text(form, 'priority') || 'P1',
      verificationStatus: text(form, 'verificationStatus') || 'pending',
      verificationNote: text(form, 'verificationNote'),
      notes: text(form, 'notes'),
      intervalMinutes: Number(text(form, 'intervalMinutes') || 60),
      autoInterval: form.has('autoInterval'),
      minIntervalMinutes: Number(text(form, 'minIntervalMinutes') || 60),
      maxIntervalMinutes: Number(text(form, 'maxIntervalMinutes') || 240),
      wechatFakeid: text(form, 'wechatFakeid'),
      wechatNickname: text(form, 'wechatNickname'),
      wechatAlias: text(form, 'wechatAlias'),
      wechatAvatarUrl: text(form, 'wechatAvatarUrl'),
    });
  });
}
export async function sourceToggleAction(_previous: { error: string } | null, form: FormData) {
  await requireAdmin();
  try {
    await toggleSource(text(form, 'id'), text(form, 'enabled') === 'true');
    revalidatePath('/admin/sources');
    return null;
  } catch (error) {
    return { error: error instanceof Error ? error.message : '操作失败，请重试' };
  }
}
export async function sourceVerifyAction(form: FormData) {
  await requireAdmin();
  const id = z.uuid().parse(text(form, 'id'));
  await perform(`/admin/sources?detail=${id}`, () => verifySource(id));
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
export async function industryAction(_form: FormData) {
  await requireAdmin();
  throw new Error('请使用栏目与选题配置');
}
export async function industryRemoveAction(_form: FormData) {
  await requireAdmin();
  throw new Error('请使用栏目与选题配置');
}
export async function editorialAction(form: FormData) {
  const section = z
    .enum(['columns', 'ratings', 'content', 'all'])
    .parse(text(form, 'editorialSection') || 'all');
  const path = `/admin/editorial/${section === 'all' ? 'columns' : section}`;
  await perform(path, async () => {
    await saveEditorialConfig({
      ...(['columns', 'all'].includes(section)
        ? {
            sections: JSON.parse(text(form, 'sections')),
            ...(form.has('highlightsConfig')
              ? {
                  highlightsDeleted: text(form, 'highlightsDeleted') === 'true',
                  ...(text(form, 'highlightsDeleted') === 'true'
                    ? { highlightsEnabled: false }
                    : {
                        highlightsName: text(form, 'highlightsName'),
                        highlightsMinItems: Number(text(form, 'highlightsMinItems')),
                        highlightsEnabled: form.has('highlightsEnabled'),
                        highlightsMaxItems: Number(text(form, 'highlightsMaxItems')),
                        highlightsBudget: Number(text(form, 'highlightsBudget')),
                        highlightsPrompt: text(form, 'highlightsPrompt'),
                      }),
                }
              : {}),
            ...(form.has('budgetTolerancePercent')
              ? { budgetTolerancePercent: Number(text(form, 'budgetTolerancePercent')) }
              : {}),
            ...(form.has('maxItems') ? { maxItems: Number(text(form, 'maxItems')) } : {}),
            ...(form.has('briefTitleMaxLength')
              ? { briefTitleMaxLength: Number(text(form, 'briefTitleMaxLength')) }
              : {}),
          }
        : {}),
      ...(['ratings', 'all'].includes(section)
        ? {
            ratingRules: JSON.parse(text(form, 'ratingRules')),
            ratingRelaxationEnabled: form.has('ratingRelaxationEnabled'),
            ratingRelaxationMaxDrop: Number(text(form, 'ratingRelaxationMaxDrop')),
            candidateRating: Number(text(form, 'candidateRating')),
            highlightRating: Number(text(form, 'highlightRating')),
          }
        : {}),
      ...(['content', 'all'].includes(section)
        ? {
            editorialPrompt: text(form, 'editorialPrompt'),
            ...(section === 'content' ? { reviewEnabled: form.has('reviewEnabled') } : {}),
          }
        : {}),
    });
  });
}
export async function publicationSettingsAction(form: FormData) {
  await perform('/admin/publications', () =>
    saveSettingsPatch({
      autoPublish: form.has('autoPublish'),
      dailyEnabled: form.has('dailyEnabled'),
      startDate: text(form, 'startDate'),
    }),
  );
}
export async function taskSettingsAction(form: FormData) {
  await perform('/admin/articles', () =>
    saveSettingsPatch({
      taskRetryLimit: Number(text(form, 'taskRetryLimit')),
      processingConcurrency: Number(text(form, 'processingConcurrency')),
    }),
  );
}
export async function systemSettingsAction(form: FormData) {
  await perform('/admin/settings', () =>
    saveSettingsPatch({ modelDailyLimit: Number(text(form, 'modelDailyLimit')) }),
  );
}
export async function globalSwitchAction(_previous: { error: string } | null, form: FormData) {
  await requireAdmin();
  try {
    const setting = z.enum(['collectionEnabled', 'deliveryEnabled']).parse(text(form, 'setting'));
    await saveSettingsPatch({ [setting]: text(form, 'enabled') === 'true' });
    revalidatePath('/', 'layout');
    return null;
  } catch (error) {
    return { error: error instanceof Error ? error.message : '保存失败' };
  }
}
export async function generateAction(form: FormData) {
  await perform('/admin/publications', async () => {
    const kind = kindSchema.parse(text(form, 'kind'));
    if (kind !== 'daily') throw new Error('目前只生成数智参阅');
    const date = text(form, 'date');
    if (!validDate(date)) throw new Error('日期格式有误');
    const { getSettings } = await import('../server/settings.ts');
    const config = await getSettings();
    const range = rangeFor(kind, date, config.dailyTime, config);
    if (form.has('reprocess')) {
      await requestReprocessing({
        from: range.start.toISOString(),
        to: range.end.toISOString(),
        scope: 'all',
        regenerateDate: date,
      });
      return;
    }
    requireModelConfig();
    const direct = form.get('direct') === 'true';
    const force = direct || form.get('force') === 'true';
    if (force && !direct && !form.has('confirmed'))
      throw new Error('请确认优先处理本期资讯后强制生成');
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
  await perform('/admin/publications', async () => {
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
      industryId: 'ai',
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
export async function requestSubscriptionAction(
  _previous: { status: 'sent' | 'error'; message?: string } | null,
  form: FormData,
): Promise<{ status: 'sent' | 'error'; message?: string }> {
  if (text(form, 'website')) return { status: 'sent' };
  try {
    await requestSubscription({ email: text(form, 'email'), kinds: ['daily'] });
    return { status: 'sent' };
  } catch (error) {
    return {
      status: 'error',
      message:
        error instanceof z.ZodError ? '请输入有效邮箱' : '确认邮件暂时无法发送，请稍后重试。',
    };
  }
}
export async function subscribeAction(form: FormData) {
  if (text(form, 'website')) redirect('/subscribe?registered=1');
  let error = '';
  try {
    await requestSubscription({ email: text(form, 'email'), kinds: ['daily'] });
  } catch (e) {
    error =
      e instanceof z.ZodError ? '请输入有效邮箱' : e instanceof Error ? e.message : '登记失败';
  }
  redirect(error ? `/subscribe?error=${encodeURIComponent(error)}` : '/subscribe?registered=1');
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
  await perform('/admin/publications', async () => {
    const { getSettings } = await import('../server/settings.ts');
    const config = await getSettings();
    const kind = kindSchema.parse(text(form, 'kind')),
      from = text(form, 'from'),
      to = text(form, 'to');
    if (kind !== 'daily') throw new Error('目前只补刊数智参阅');
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
      const time = config.dailyTime;
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
    redirect('/admin/publications?error=' + encodeURIComponent('类型或日期无效'));
  redirect(
    '/admin/publications?' +
      new URLSearchParams({
        preview: '1',
        kind: kind.data,
        date,
        ...(form.has('reprocess') ? { reprocess: '1' } : {}),
      }),
  );
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
  await perform('/admin/settings', async () =>
    saveSettingsPatch({
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
    `/admin/settings?${failed ? 'error' : 'notice'}=${encodeURIComponent(notice)}&event=${crypto.randomUUID()}`,
  );
}

export async function sourceReviewAction(form: FormData) {
  await requireAdmin();
  const sourceId = z.uuid().parse(text(form, 'sourceId'));
  const date = text(form, 'date');
  const path = `/admin/sources/monitor?${new URLSearchParams({ source: sourceId, ...(validDate(date) ? { date } : {}) })}`;
  await perform(path, async () => {
    const verdict = z
      .enum(['keep', 'scope', 'slower', 'stop', 'observe'])
      .parse(text(form, 'verdict'));
    const evidence = z
      .enum(['original', 'reprint', 'aggregator', 'unknown'])
      .parse(text(form, 'evidenceKind'));
    const completeness = z
      .enum(['sufficient', 'thin', 'title', 'unknown'])
      .parse(text(form, 'completeness'));
    const note = z.string().trim().min(1).max(2000).parse(text(form, 'note'));
    const urls = z
      .array(z.url().refine((v) => /^https?:/.test(v)))
      .max(20)
      .parse(text(form, 'urls').split(/\s+/).filter(Boolean));
    await pool.query(
      'INSERT INTO source_reviews(source_id,verdict,evidence_kind,completeness,note,urls) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
      [sourceId, verdict, evidence, completeness, note, JSON.stringify(urls)],
    );
    revalidatePath('/admin/sources/monitor');
  });
}
