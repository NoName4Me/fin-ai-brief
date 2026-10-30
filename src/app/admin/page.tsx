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
  const period = query.view === '30' ? 30 : query.view === '7' ? 7 : null;
  const [data, charts] = await Promise.all([
    adminOverview(),
    period ? dashboardCharts(period) : Promise.resolve(null),
  ]);
  const otherSourceStates = [
    { state: 'new', label: '待首采' },
    { state: 'paused', label: '采集暂停' },
    { state: 'overdue', label: '调度逾期' },
  ]
    .map((item) => ({
      ...item,
      count: data.sources.filter((source) => source.state === item.state).length,
    }))
    .filter((item) => item.count > 0);
  const latestDate = data.sections[0]?.period_date;
  const sectionErrors = data.sections.filter((section) => section.status === 'error');
  const currentSectionErrors = sectionErrors.filter((section) => section.period_date === data.date);
  return (
    <div className="admin-overview">
      <Notice query={query} />
      <div className="overview-heading">
        <span>{data.date} · 北京时间</span>
        <nav className="overview-tabs" aria-label="看板周期">
          <Link href="/admin" aria-current={!period ? 'page' : undefined}>
            今日
          </Link>
          <Link href="/admin?view=7" aria-current={period === 7 ? 'page' : undefined}>
            近7天
          </Link>
          <Link href="/admin?view=30" aria-current={period === 30 ? 'page' : undefined}>
            近30天
          </Link>
        </nav>
        <span>{charts ? `${charts.range.start} 至 ${charts.range.end}` : '运行与待办'}</span>
      </div>
      {charts ? (
        <DashboardCharts data={charts} />
      ) : (
        <>
          <section
            className="overview-section overview-collection"
            aria-labelledby="collection-title"
          >
            <div className="overview-section-heading">
              <h2 id="collection-title">本轮采集</h2>
              <span className="muted">{taskStamp(data.exceptions.since).slice(5, 16)} 至今</span>
            </div>
            <dl className="overview-cycle-metrics">
              <div>
                <dt>新增资讯</dt>
                <dd>
                  <Link href="/admin/articles">
                    {data.counts.incoming}
                    <small>篇</small>
                  </Link>
                </dd>
              </div>
              <div>
                <dt>当前异常信源</dt>
                <dd className={data.exceptions.collection ? 'overview-problem' : undefined}>
                  <Link href="/admin/sources/monitor?status=cycle_error">
                    {data.exceptions.collection}
                    <small>个</small>
                  </Link>
                </dd>
              </div>
            </dl>
            <p className="form-hint">
              启用信源 {data.sources.length}
              {otherSourceStates.map((item) => (
                <span key={item.state}>
                  {' '}
                  · {item.label} {item.count}
                </span>
              ))}
              {' · '}
              <Link href="/admin/sources/monitor">信源监控</Link>
            </p>
            <p className="form-hint">
              上一周期曾异常：采集 {data.exceptions.previous.collection}、处理{' '}
              {data.exceptions.previous.processing}、出刊 {data.exceptions.previous.generation}
            </p>
          </section>
          <div className="overview-columns">
            <section className="overview-section" aria-labelledby="today-title">
              <div className="overview-section-heading">
                <h2 id="today-title">本期出刊</h2>
                <Link href="/admin/publications">出刊管理</Link>
              </div>
              <p className="overview-edition-state">
                {data.status}
                {currentSectionErrors.length > 0 && (
                  <span className="overview-problem">
                    {' '}
                    · {currentSectionErrors.length} 个栏目异常
                  </span>
                )}
              </p>
              {data.today?.title && <p>{data.today.title}</p>}
              {data.today?.is_published && (
                <p className="form-hint">发布时间 {taskStamp(data.today.published_at)}</p>
              )}
              {data.generationError && <p className="overview-problem">{data.generationError}</p>}
              <div className="row-actions">
                {data.today?.has_draft && (
                  <Link href={`/admin/briefs/${data.today.id}`}>审核待审稿</Link>
                )}
                {data.today?.is_published && (
                  <Link href={`/briefs/${data.today.id}`}>阅读正式版</Link>
                )}
                <Link href="/admin/articles?type=generate">查看出刊任务</Link>
              </div>
              <p className="form-hint">
                {data.config.dailyTime} 截稿 ·{' '}
                {data.config.dailyEnabled ? '自动出刊已开启' : '自动出刊已暂停'} ·{' '}
                {data.config.autoPublish ? '自动发布' : '人工审核后发布'}
              </p>
              <div className="today-section-status">
                <div className="overview-section-heading">
                  <h3>最近一期栏目{latestDate && <small>{latestDate}</small>}</h3>
                  <Link href={data.editionTask?.href ?? '/admin/articles?type=generate'}>
                    选题明细
                  </Link>
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
                          {
                            data.sections.filter((section) => section.status === 'unscheduled')
                              .length
                          }
                        </strong>
                      </span>
                      {sectionErrors.length > 0 && (
                        <span className={latestDate === data.date ? 'overview-problem' : 'muted'}>
                          异常 <strong>{sectionErrors.length}</strong>
                        </span>
                      )}
                    </div>
                    {sectionErrors.length > 0 && (
                      <ul className="overview-alerts">
                        {sectionErrors.slice(0, 3).map((section) => (
                          <li key={section.section}>
                            <span>{section.section}</span>
                            <span
                              className={latestDate === data.date ? 'overview-problem' : 'muted'}
                            >
                              {section.reason}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <p className="muted">暂无出刊记录。</p>
                )}
              </div>
            </section>
            <section className="overview-section" aria-labelledby="pending-title">
              <div className="overview-section-heading">
                <h2 id="pending-title">
                  待办<small>全部积压</small>
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
                    <Link href="/admin/publications">待审核日报</Link>
                  </dt>
                  <dd>{data.counts.drafts} 期</dd>
                </div>
              </dl>
            </section>
          </div>
          <div className="overview-runtime">
            <span>
              模型调用：今日 {data.usage.used} / {data.usage.limit} 次，剩余 {data.usage.remaining}{' '}
              次
            </span>
            <Link href="/admin/settings">系统设置</Link>
          </div>
        </>
      )}
    </div>
  );
}
