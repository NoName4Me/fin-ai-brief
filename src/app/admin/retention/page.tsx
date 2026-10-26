import { requireAdmin } from '../../../server/auth.ts';
import { getSettings } from '../../../server/settings.ts';
import { retentionSettingsAction, cleanupRetentionAction } from '../../actions.ts';
import { Notice, type Query } from '../../../components/notice.tsx';
export default async function Retention({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const config = await getSettings();
  return (
    <>
      <Notice query={await searchParams} />
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
          <p className="form-hint">每日北京时间 03:20 执行，日报、周报、月报归档始终保留。</p>
          <label>
            7×24 资讯保留天数
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
          <p className="form-hint">
            每日按保留天数清理。资讯过期后移出7×24；未出刊月报所需材料暂缓删除。正在处理的任务及排队中、发送中的邮件暂不清理。
          </p>
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
