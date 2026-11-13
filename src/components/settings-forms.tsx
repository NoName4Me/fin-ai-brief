import type { Settings } from '../server/types.ts';
import {
  publicationSettingsAction,
  taskSettingsAction,
  cleanupRetentionAction,
} from '../app/actions.ts';
import { Save, Trash2 } from 'lucide-react';
import { Switch } from './switch.tsx';
export function PublicationSettingsForm({ config }: { config: Settings }) {
  return (
    <form action={publicationSettingsAction} className="stack-form settings-dialog-form">
      <label>
        起刊日期
        <input type="date" name="startDate" defaultValue={config.startDate} required />
      </label>
      <label className="check">
        <input type="checkbox" name="dailyEnabled" defaultChecked={config.dailyEnabled} />
        开启每日自动出刊
      </label>
      <label>
        截稿时间（北京时间）
        <input type="time" value="08:00" readOnly />
      </label>
      <label className="check">
        <input type="checkbox" name="autoPublish" defaultChecked={config.autoPublish} />
        生成成功后直接发布
      </label>
      <button className="solid-button">
        <Save className="icon" strokeWidth={1.75} aria-hidden="true" />
        保存
      </button>
    </form>
  );
}
export function TaskSettingsForm({ config }: { config: Settings }) {
  return (
    <form action={taskSettingsAction} className="stack-form settings-dialog-form">
      <label>
        失败后自动重试次数
        <input
          type="number"
          name="taskRetryLimit"
          min={0}
          max={3}
          defaultValue={config.taskRetryLimit}
          required
        />
      </label>
      <label>
        资讯处理并发数
        <input
          type="number"
          name="processingConcurrency"
          min={1}
          max={20}
          defaultValue={config.processingConcurrency}
          required
        />
      </label>
      <button className="solid-button">
        <Save className="icon" strokeWidth={1.75} aria-hidden="true" />
        保存
      </button>
    </form>
  );
}
export function RetentionSettingsFields({ config }: { config: Settings }) {
  return (
    <fieldset>
      <legend>数据保留</legend>
      <div className="settings-control-row">
        <label className="settings-switch-label">
          <Switch
            name="retentionEnabled"
            defaultChecked={config.retentionEnabled}
            aria-label="开启自动清理"
          />
          开启自动清理
        </label>
        <button
          className="outline-button"
          formAction={cleanupRetentionAction}
          formNoValidate
          disabled={!config.retentionEnabled}
        >
          <Trash2 className="icon" strokeWidth={1.75} aria-hidden="true" />
          立即清理
        </button>
      </div>
      <p className="form-hint">每日北京时间 03:20 执行，已发布刊期始终保留。</p>
      <div className="settings-field-grid">
        <label>
          原始资讯保留天数
          <input
            name="newsRetentionDays"
            type="number"
            min={7}
            max={3650}
            defaultValue={config.newsRetentionDays}
            required
          />
        </label>
        <label>
          任务及过程数据保留天数
          <input
            name="taskRetentionDays"
            type="number"
            min={1}
            max={3650}
            defaultValue={config.taskRetentionDays}
            required
          />
        </label>
        <label>
          邮件推送记录保留天数
          <input
            name="mailRetentionDays"
            type="number"
            min={1}
            max={3650}
            defaultValue={config.mailRetentionDays}
            required
          />
        </label>
        <label>
          模型运行日志保留天数
          <input
            name="modelLogRetentionDays"
            type="number"
            min={1}
            max={365}
            defaultValue={config.modelLogRetentionDays}
            required
          />
        </label>
      </div>
      <p className="form-hint">
        模型异常、探测和切换日志按此期限清理；任务与缓存记录仍按各自规则保留。
      </p>
    </fieldset>
  );
}
