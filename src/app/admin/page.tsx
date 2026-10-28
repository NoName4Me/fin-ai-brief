import Link from 'next/link';
import { DashboardCharts } from '../../components/dashboard-charts.tsx';
import { dashboardCharts } from '../../server/dashboard-charts.ts';
import { redirect } from 'next/navigation';
import { requireAdmin } from '../../server/auth.ts';
import { adminOverview } from '../../server/admin-overview.ts';
import { taskStamp } from '../../server/task-labels.ts';
import { Notice, type Query } from '../../components/notice.tsx';

export default async function Dashboard({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const query = await searchParams;
  if (query.preview === '1' || query.reprocess === '1') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (typeof value === 'string') params.set(key, value);
    redirect(`/admin/publications?${params}`);
  }
  const [data, charts] = await Promise.all([adminOverview(), dashboardCharts()]);
  const healthy = data.sources.filter((source) => source.state === 'healthy').length;
  const abnormal = data.sources.filter((source) =>
    ['failed', 'overdue'].includes(source.state),
  ).length;
  const otherSourceStates = [
    { state: 'new', label: '待首采' },
    { state: 'retry', label: '重试中' },
    { state: 'paused', label: '采集暂停' },
  ]
    .map((item) => ({
      ...item,
      count: data.sources.filter((source) => source.state === item.state).length,
    }))
    .filter((item) => item.count > 0);
  const latestDate = data.sections[0]?.period_date;
  return (
    <div className="admin-overview">
      <Notice query={query} />
      <div className="overview-heading">
        <span>{data.date} · 北京时间</span>
      </div>
      <dl className="overview-totals">
        <div>
          <dt>累计已发日报</dt>
          <dd>
            <Link href="/admin/publications">
              <span className="overview-number">{data.counts.published}</span>
              <small>期</small>
            </Link>
          </dd>
        </div>
        <div>
          <dt>今日新增入库</dt>
          <dd>
            <Link href="/admin/articles">
              <span className="overview-number">{data.counts.incoming}</span>
              <small>篇</small>
            </Link>
            <span className="overview-card-detail">
              <span>有效 {data.counts.incoming_relevant}</span>
              <span>淘汰 {data.counts.incoming_ignored}</span>
              <span>待处理 {data.counts.incoming_pending}</span>
              {data.counts.incoming_failed > 0 && (
                <span className="overview-problem">失败 {data.counts.incoming_failed}</span>
              )}
            </span>
          </dd>
        </div>
        <div>
          <dt>启用信源 {data.sources.length}</dt>
          <dd>
            <Link href="/admin/sources/monitor" className="overview-source-numbers">
              <span>
                <span className="overview-number overview-healthy-number">{healthy}</span>
                <small>正常</small>
              </span>
              <span>
                <span className={`overview-number${abnormal > 0 ? ' overview-problem' : ''}`}>
                  {abnormal}
                </span>
                <small>异常</small>
              </span>
            </Link>
            {otherSourceStates.length > 0 && (
              <span className="overview-card-detail">
                {otherSourceStates.map((item) => (
                  <span key={item.state}>
                    {item.label} {item.count}
                  </span>
                ))}
              </span>
            )}
          </dd>
        </div>
      </dl>
      <div className="overview-columns">
        <section className="overview-section" aria-labelledby="today-title">
          <div className="overview-section-heading">
            <h2 id="today-title">今日出刊</h2>
            <Link href="/admin/publications">出刊管理</Link>
          </div>
          <p className="overview-edition-state">{data.status}</p>
          {data.today?.title && <p>{data.today.title}</p>}
          {data.today?.is_published && (
            <p className="form-hint">发布时间 {taskStamp(data.today.published_at)}</p>
          )}
          {data.generationError && <p className="overview-problem">{data.generationError}</p>}
          <div className="row-actions">
            {data.today?.has_draft && (
              <Link href={`/admin/briefs/${data.today.id}`}>审核待审稿</Link>
            )}
            {data.today?.is_published && <Link href={`/briefs/${data.today.id}`}>阅读正式版</Link>}
            <Link href="/admin/articles?type=generate">查看出刊任务</Link>
          </div>
          <p className="form-hint">
            08:00 截稿 · {data.config.dailyEnabled ? '自动出刊已开启' : '自动出刊已暂停'} ·{' '}
            {data.config.autoPublish ? '自动发布' : '人工审核后发布'}
          </p>
        </section>
        <section className="overview-section" aria-labelledby="pending-title">
          <div className="overview-section-heading">
            <h2 id="pending-title">
              待处理<small>全部积压</small>
            </h2>
            <Link href="/admin/articles">任务管理</Link>
          </div>
          <dl className="overview-list">
            <div>
              <dt>
                <Link href="/admin/articles?type=process&state=created">待处理资讯</Link>
              </dt>
              <dd>{data.counts.pending} 篇</dd>
            </div>
            <div>
              <dt>
                <Link href="/admin/articles?type=process&state=failed">处理失败资讯</Link>
              </dt>
              <dd className={data.counts.failed ? 'overview-problem' : undefined}>
                {data.counts.failed} 篇
              </dd>
            </div>
            <div>
              <dt>
                <Link href="/admin/sources/monitor">采集失败信源</Link>
              </dt>
              <dd
                className={data.sources.some((s) => s.last_error) ? 'overview-problem' : undefined}
              >
                {data.sources.filter((s) => s.last_error).length} 个
              </dd>
            </div>
            <div>
              <dt>
                <Link href="/admin/publications">待审核日报</Link>
              </dt>
              <dd>{data.counts.drafts} 期</dd>
            </div>
          </dl>
        </section>
      </div>
      <DashboardCharts data={charts} />
      <section className="overview-section" aria-labelledby="coverage-title">
        <div className="overview-section-heading">
          <h2 id="coverage-title">最近一期栏目{latestDate && <small>{latestDate}</small>}</h2>
          <Link href={data.editionTask?.href ?? '/admin/articles?type=generate'}>选题明细</Link>
        </div>
        {data.editionTask && (
          <p className="form-hint edition-result-origin">
            {data.editionTask.label} · {taskStamp(data.editionTask.at)}
          </p>
        )}
        {data.sections.length ? (
          <>
            <div className="overview-health">
              <span>
                有内容{' '}
                <strong>
                  {data.sections.filter((section) => section.selected_count > 0).length}
                </strong>
              </span>
              <span>
                正常留空{' '}
                <strong>
                  {data.sections.filter((section) => section.status === 'skipped').length}
                </strong>
              </span>
              <span>
                未排期{' '}
                <strong>
                  {data.sections.filter((section) => section.status === 'unscheduled').length}
                </strong>
              </span>
              {data.sections.some((section) => section.status === 'error') && (
                <span className="overview-problem">
                  异常{' '}
                  <strong>
                    {data.sections.filter((section) => section.status === 'error').length}
                  </strong>
                </span>
              )}
            </div>
            {data.sections.some((section) => section.status === 'error') && (
              <ul className="overview-alerts">
                {data.sections
                  .filter((section) => section.status === 'error')
                  .slice(0, 3)
                  .map((section) => (
                    <li key={section.section}>
                      <span>{section.section}</span>
                      <span className="overview-problem">{section.reason}</span>
                    </li>
                  ))}
              </ul>
            )}
          </>
        ) : (
          <p className="muted">暂无出刊记录。</p>
        )}
      </section>
      <div className="overview-runtime">
        <span>
          模型调用：今日 {data.usage.used} / {data.usage.limit} 次，剩余 {data.usage.remaining} 次
        </span>
        <Link href="/admin/settings">系统设置</Link>
      </div>
    </div>
  );
}
