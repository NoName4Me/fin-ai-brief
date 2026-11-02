import { requireAdmin } from '../../../server/auth.ts';
import { getSettings } from '../../../server/settings.ts';
import { modelUsage, getModelConnection } from '../../../server/model.ts';
import { systemSettingsAction } from '../../actions.ts';
import { RetentionSettingsFields } from '../../../components/settings-forms.tsx';
import { Notice, type Query } from '../../../components/notice.tsx';
import { redirect } from 'next/navigation';
import { Save } from 'lucide-react';
import { Switch } from '../../../components/switch.tsx';
import { ModelConnectionTest } from '../../../components/model-connection-test.tsx';
export default async function Page({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const query = await searchParams;
  if (query.from && query.to) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (typeof value === 'string') params.set(key, value);
    redirect(`/admin/backfill?${params}`);
  }
  const [config, usage, connection] = await Promise.all([
    getSettings(),
    modelUsage(),
    getModelConnection(),
  ]);
  return (
    <>
      <Notice query={query} />
      <form action={systemSettingsAction} className="stack-form system-settings-form">
        <fieldset>
          <legend>模型配置与额度</legend>
          <label className="settings-switch-label">
            <Switch
              name="modelCallsEnabled"
              defaultChecked={connection.enabled}
              aria-label="开启模型调用"
            />
            开启模型调用
          </label>
          <label>
            API 地址
            <input
              name="modelBaseUrl"
              type="url"
              defaultValue={connection.baseUrl}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <label>
            API Key
            <input
              name="modelApiKey"
              type="password"
              autoComplete="new-password"
              placeholder={connection.apiKey ? '已配置，留空保留' : '填写 API Key'}
            />
          </label>
          <div className="settings-field-grid">
            <label>
              模型名称
              <input name="modelName" defaultValue={connection.model} />
            </label>
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
          </div>
          <p className="form-hint">
            今日已用 {usage.used} 次，剩余 {usage.remaining}{' '}
            次。北京时间零点重置，失败请求也计入次数。
          </p>
          <ModelConnectionTest />
        </fieldset>
        <RetentionSettingsFields config={config} />
        <button className="solid-button">
          <Save className="icon" strokeWidth={1.75} aria-hidden="true" />
          保存
        </button>
      </form>
    </>
  );
}
