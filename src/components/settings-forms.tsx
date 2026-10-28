import type { Settings } from '../server/types.ts';
import {
  publicationSettingsAction,
  taskSettingsAction,
  retentionSettingsAction,
  cleanupRetentionAction,
} from '../app/actions.ts';
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
      <button className="solid-button">保存出刊设置</button>
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
      <button className="solid-button">保存任务配置</button>
    </form>
  );
}
export function RetentionSettingsForm({ config }: { config: Settings }) {
  return (
    <>
      <form action={retentionSettingsAction} className="stack-form">
        <fieldset>
          <legend>数据保留</legend>
          <label className="check">
            <input
              name="retentionEnabled"
              type="checkbox"
              defaultChecked={config.retentionEnabled}
            />
            开启自动清理
          </label>
          <p className="form-hint">每日北京时间 03:20 执行，已发布刊期始终保留。</p>
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
          <p className="form-hint">正在处理的任务及排队中、发送中的邮件暂不清理。</p>
        </fieldset>
        <button className="solid-button">保存保留规则</button>
      </form>
      <section className="admin-section">
        <h2>立即清理</h2>
        <form action={cleanupRetentionAction}>
          <button className="outline-button" disabled={!config.retentionEnabled}>
            按已保存规则清理
          </button>
        </form>
      </section>
    </>
  );
}
