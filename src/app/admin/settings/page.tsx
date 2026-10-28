import { requireAdmin } from '../../../server/auth.ts';
import { getSettings } from '../../../server/settings.ts';
import { modelUsage } from '../../../server/model.ts';
import { systemSettingsAction } from '../../actions.ts';
import { RetentionSettingsForm } from '../../../components/settings-forms.tsx';
import { Notice, type Query } from '../../../components/notice.tsx';
import { redirect } from 'next/navigation';
export default async function Page({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const query = await searchParams;
  if (query.from && query.to) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (typeof value === 'string') params.set(key, value);
    redirect(`/admin/backfill?${params}`);
  }
  const [config, usage] = await Promise.all([getSettings(), modelUsage()]);
  return (
    <>
      <Notice query={query} />
      <form action={systemSettingsAction} className="stack-form">
        <fieldset>
          <legend>模型调用额度</legend>
          <p>
            今日已用 {usage.used} 次 / 上限 {usage.limit} 次，剩余 {usage.remaining} 次。
          </p>
          <label>
            每日调用次数上限
            <input
              type="number"
              name="modelDailyLimit"
              min={1}
              max={100000}
              defaultValue={config.modelDailyLimit}
              required
            />
          </label>
          <p className="form-hint">北京时间零点重置，失败请求也计入次数。</p>
        </fieldset>
        <button className="solid-button">保存模型额度</button>
      </form>
      <RetentionSettingsForm config={config} />
      <section className="admin-section">
        <h2>连接状态</h2>
        <p>模型：{process.env.LLM_MODEL || '未配置'}</p>
        <p>API 地址：{process.env.LLM_BASE_URL || '未配置'}</p>
        <p>
          模型调用：{process.env.MODEL_CALLS_ENABLED === 'true' ? '已开启' : '未开启'}　API Key：
          {process.env.LLM_API_KEY ? '已配置' : '未配置'}　邮件：
          {process.env.MAIL_ENABLED === 'true' ? '已开启' : '未开启'}
        </p>
      </section>
    </>
  );
}
