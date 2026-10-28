import Link from 'next/link';
import { requireAdmin } from '../../../../server/auth.ts';
import { sourceMetrics } from '../../../../server/source-metrics.ts';
import { adminOverview } from '../../../../server/admin-overview.ts';
import { taskStamp } from '../../../../server/task-labels.ts';
const labels: Record<string, string> = {
  healthy: '正常',
  failed: '连续失败',
  retry: '重试中',
  new: '待首采',
  overdue: '采集逾期',
  paused: '采集已暂停',
};
export default async function Page() {
  await requireAdmin();
  const [overview, rows] = await Promise.all([adminOverview(), sourceMetrics()]);
  const counts = (state: string) => overview.sources.filter((s) => s.state === state).length;
  return (
    <div className="source-monitor">
      <section className="overview-section" aria-labelledby="source-health">
        <div className="overview-section-heading">
          <h2 id="source-health">运行状态</h2>
          <Link href="/admin/sources">信源管理</Link>
        </div>
        <div className="overview-health">
          <span>
            正常 <strong>{counts('healthy')}</strong>
          </span>
          <span>
            连续失败 <strong>{counts('failed')}</strong>
          </span>
          <span>
            重试中 <strong>{counts('retry')}</strong>
          </span>
          <span>
            待首采 <strong>{counts('new')}</strong>
          </span>
          <span>
            采集逾期 <strong>{counts('overdue')}</strong>
          </span>
          {counts('paused') > 0 && (
            <span>
              采集已暂停 <strong>{counts('paused')}</strong>
            </span>
          )}
          {!overview.config.collectionEnabled && <span>自动采集已暂停</span>}
        </div>
        {overview.sources.filter((s) => ['failed', 'overdue'].includes(s.state)).length > 0 && (
          <ul className="overview-alerts">
            {overview.sources
              .filter((s) => ['failed', 'overdue'].includes(s.state))
              .map((s) => (
                <li key={s.id}>
                  <Link href={`/admin/sources?detail=${s.id}`}>{s.name}</Link>
                  <span className="overview-problem">{labels[s.state]}</span>
                  {s.last_error && <span className="muted">{s.last_error}</span>}
                </li>
              ))}
          </ul>
        )}
      </section>
      <section className="overview-section" aria-labelledby="source-value">
        <div className="overview-section-heading">
          <h2 id="source-value">
            采集与内容贡献 <small>近30天</small>
          </h2>
        </div>
        <p className="form-hint">
          抓取、入库与有效资讯按近30天采集统计；入选和要览按近30天已发布日报引用统计，按现存记录计算。
        </p>
        <div
          className="table-wrap source-monitor-table"
          role="region"
          aria-label="信源监控列表"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>信源</th>
                <th>状态</th>
                <th>抓取</th>
                <th>入库</th>
                <th>有效资讯</th>
                <th>独立事件</th>
                <th>日报入选</th>
                <th>进入要览</th>
                <th>最近采集</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const health = overview.sources.find((h) => h.id === s.id);
                return (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/admin/sources?detail=${s.id}`}>{s.name}</Link>
                    </td>
                    <td
                      className={
                        health?.state === 'failed' || health?.state === 'overdue'
                          ? 'overview-problem'
                          : undefined
                      }
                    >
                      {s.enabled ? labels[health?.state ?? 'new'] : '已停用'}
                    </td>
                    <td>{s.fetched}</td>
                    <td>{s.articles}</td>
                    <td>{s.relevant}</td>
                    <td>{s.events}</td>
                    <td>{s.selected}</td>
                    <td>{s.highlights}</td>
                    <td>{s.last_fetched_at ? taskStamp(s.last_fetched_at) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!rows.length && <p className="empty-state">暂无信源。</p>}
      </section>
    </div>
  );
}
