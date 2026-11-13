import Link from 'next/link';
import { Suspense } from 'react';
import { DashboardPanels, DashboardLoading } from '../../components/dashboard-panels.tsx';
import { dashboardRange } from '../../server/dashboard-charts.ts';
import { redirect } from 'next/navigation';
import { requireAdmin } from '../../server/auth.ts';
import { adminOverview } from '../../server/admin-overview.ts';
import { describeModelOverviewStatus } from '../../server/admin-models.ts';
import { taskStamp } from '../../server/task-labels.ts';
import { rangeFor, localDate } from '../../server/periods.ts';
import { Notice, type Query } from '../../components/notice.tsx';

type Overview = ReturnType<typeof adminOverview>;
function cycleLabel(start: Date, end: Date) {
  return `${taskStamp(start).slice(0, 16)}—${taskStamp(end).slice(0, 16)}`;
}
async function CurrentCycleLabel({ data }: { data: Overview }) {
  const value = await data;
  return cycleLabel(value.cycle.start, value.cycle.end);
}
async function CurrentCycle({ overview }: { overview: Overview }) {
  const data = await overview;
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
  const sectionErrors = data.sections.filter((section) => section.status === 'error');
  const modelStatus = describeModelOverviewStatus({
    status: data.model.status,
    enabledCount: data.model.enabledCount,
    usableCount: data.model.usableCount,
    currentName: data.model.current?.name,
    primaryName: data.model.primary?.name,
    primaryEnabled: data.model.primary?.enabled,
  });
  const latestCycle = data.latestPublished
    ? rangeFor('daily', data.latestPublished.period_date, data.config.dailyTime)
    : null;
  return (
    <>
      <section className="overview-section overview-actions" aria-labelledby="actions-title">
        <div className="overview-section-heading">
          <h2 id="actions-title">
            异常与待办<small>当前生产周期</small>
          </h2>
        </div>
        <dl className="overview-action-metrics">
          <div className="overview-model-metric">
            <dt>模型状况</dt>
            <dd className={`overview-model-metric-value state-${data.model.status}`}>
              <Link href="/admin/models?panel=logs&tab=events">
                <span
                  className={`overview-model-state-icon state-${data.model.status}`}
                  aria-hidden="true"
                />
                {modelStatus.label}
              </Link>
              <small className="overview-model-metric-detail">
                {modelStatus.detail}
                {' · '}异常 {data.model.failures} 次 · 切换 {data.model.fallbacks} 次
              </small>
            </dd>
          </div>
          <div>
            <dt>处理失败资讯</dt>
            <dd className={data.counts.failed ? 'overview-problem' : undefined}>
              <Link href="/admin/articles?type=process&state=failed">
                {data.counts.failed}
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
          <div>
            <dt>待处理资讯</dt>
            <dd>
              <Link href="/admin/articles?type=process&state=created">
                {data.counts.pending}
                <small>篇</small>
              </Link>
            </dd>
          </div>
          <div>
            <dt>待审核日报</dt>
            <dd>
              <Link href="/admin/publications">
                {data.counts.drafts}
                <small>期</small>
              </Link>
            </dd>
          </div>
        </dl>
      </section>
      <div className="overview-columns">
        <section className="overview-section" aria-labelledby="today-title">
          <div className="overview-section-heading">
            <h2 id="today-title">
              下一期出刊<small>{data.nextIssueDate}刊</small>
            </h2>
            <Link href="/admin/publications">出刊管理</Link>
          </div>
          <p className="overview-edition-state">
            {data.status}
            {sectionErrors.length > 0 && (
              <span className="overview-problem"> · {sectionErrors.length} 个栏目异常</span>
            )}
          </p>
          {data.currentIssue?.title && <p>{data.currentIssue.title}</p>}
          {data.currentIssue?.is_published && (
            <p className="form-hint">发布时间 {taskStamp(data.currentIssue.published_at)}</p>
          )}
          {data.generationError && <p className="overview-problem">{data.generationError}</p>}
          <div className="row-actions overview-edition-actions">
            {data.currentIssue?.has_draft && (
              <Link
                className="overview-primary-action"
                href={`/admin/briefs/${data.currentIssue.id}`}
              >
                审核待审稿
              </Link>
            )}
            {data.currentIssue?.is_published && (
              <Link
                className="overview-primary-action"
                href={`/briefs/${data.currentIssue.id}`}
                target="_blank"
              >
                阅读正式版
              </Link>
            )}
            <Link href="/admin/articles?type=generate">查看出刊任务</Link>
          </div>
          <p className="form-hint">
            {data.config.dailyTime} 截稿 ·{' '}
            {data.config.dailyEnabled ? '自动出刊已开启' : '自动出刊已暂停'} ·{' '}
            {data.config.autoPublish ? '自动发布' : '人工审核后发布'}
          </p>
          {!!data.sections.length && (
            <div className="today-section-status">
              <div className="overview-section-heading">
                <h3>本期栏目</h3>
                <Link href={data.editionTask?.href ?? '/admin/articles?type=generate'}>
                  选题明细
                </Link>
              </div>
              {data.editionTask && (
                <p className="form-hint edition-result-origin">
                  {data.editionTask.label} · {taskStamp(data.editionTask.at)}
                </p>
              )}
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
                {sectionErrors.length > 0 && (
                  <span className="overview-problem">
                    异常 <strong>{sectionErrors.length}</strong>
                  </span>
                )}
              </div>
              {sectionErrors.length > 0 && (
                <ul className="overview-alerts">
                  {sectionErrors.slice(0, 3).map((section) => (
                    <li key={section.section}>
                      <span>{section.section}</span>
                      <span className="overview-problem">{section.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
        <section className="overview-section" aria-labelledby="latest-title">
          <div className="overview-section-heading">
            <h2 id="latest-title">
              最近出刊
              {data.latestPublished && <small>{data.latestPublished.period_date}刊</small>}
            </h2>
            <Link href="/admin/publications">全部刊期</Link>
          </div>
          {data.latestPublished && latestCycle ? (
            <>
              <p className="overview-edition-title">{data.latestPublished.title}</p>
              <p className="form-hint">内容覆盖 {cycleLabel(latestCycle.start, latestCycle.end)}</p>
              <p className="form-hint">发布时间 {taskStamp(data.latestPublished.published_at)}</p>
              <div className="row-actions overview-edition-actions">
                <Link
                  className="overview-primary-action"
                  href={`/briefs/${data.latestPublished.id}`}
                  target="_blank"
                >
                  阅读正式版
                </Link>
              </div>
            </>
          ) : (
            <p className="muted">暂无正式出刊。</p>
          )}
        </section>
      </div>
      <section className="overview-section overview-collection" aria-labelledby="collection-title">
        <div className="overview-section-heading">
          <h2 id="collection-title">本轮采集</h2>
          <span className="muted">截至 {taskStamp(data.exceptions.until).slice(5, 16)}</span>
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
            <dt>有效资讯</dt>
            <dd>
              {data.counts.incoming_relevant}
              <small>篇</small>
            </dd>
          </div>
          <div>
            <dt>未入选</dt>
            <dd>
              {data.counts.incoming_ignored}
              <small>篇</small>
            </dd>
          </div>
          <div>
            <dt>启用信源</dt>
            <dd>
              <Link href="/admin/sources/monitor">
                {data.sources.length}
                <small>个</small>
              </Link>
            </dd>
          </div>
        </dl>
        {otherSourceStates.length > 0 && (
          <p className="form-hint">
            {otherSourceStates.map((item, index) => (
              <span key={item.state}>
                {index > 0 && ' · '}
                {item.label} {item.count}
              </span>
            ))}
          </p>
        )}
      </section>
      <div className="overview-runtime">
        <span>
          模型调用：今日 {data.usage.used} / {data.usage.limit} 次 · 本期 token 用量（
          {data.nextIssueDate}） {data.tokenUsage.current.toLocaleString('zh-CN')}
          {' · '}上期（{data.latestPublished?.period_date ?? '—'}）{' '}
          {data.tokenUsage.previous === null
            ? '—'
            : data.tokenUsage.previous.toLocaleString('zh-CN')}
        </span>
      </div>
    </>
  );
}

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
  const now = new Date();
  const overview = period ? null : adminOverview(now);
  return (
    <div className="admin-overview">
      <Notice query={query} />
      <div className="overview-heading">
        <span>今日 {localDate(now)}</span>
        <nav className="overview-tabs" aria-label="看板周期">
          <Link href="/admin" aria-current={!period ? 'page' : undefined}>
            当前周期
          </Link>
          <Link href="/admin?view=7" aria-current={period === 7 ? 'page' : undefined}>
            近7天趋势
          </Link>
          <Link href="/admin?view=30" aria-current={period === 30 ? 'page' : undefined}>
            近30天趋势
          </Link>
        </nav>
        <span>
          {period ? (
            `${localDate(dashboardRange(period, now).start)} 至 ${localDate(now)}`
          ) : (
            <Suspense fallback="正在读取周期…">
              <CurrentCycleLabel data={overview!} />
            </Suspense>
          )}
        </span>
      </div>
      {period ? (
        <DashboardPanels key={period} days={period} now={now} />
      ) : (
        <Suspense key="current" fallback={<DashboardLoading label="当前周期" />}>
          <CurrentCycle overview={overview!} />
        </Suspense>
      )}
    </div>
  );
}
