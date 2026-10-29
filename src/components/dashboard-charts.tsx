import Link from 'next/link';
import type { dashboardCharts } from '../server/dashboard-charts.ts';
type ChartData = Awaited<ReturnType<typeof dashboardCharts>>;

const percent = (value: number) => `${value.toFixed(1)}%`;
const chartLabels = (length: number) => [...new Set([0, Math.floor((length - 1) / 2), length - 1])];

function ContentTrend({ data }: { data: ChartData['trend'] }) {
  const width = 720,
    height = 190,
    left = 38,
    right = 12,
    top = 20,
    bottom = 34;
  const plotWidth = width - left - right,
    plotHeight = height - top - bottom;
  const max = Math.max(1, ...data.map((day) => day.qualified));
  const step = plotWidth / data.length;
  return (
    <svg
      className="dashboard-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`每日合格事件与日报采用：${data.map((day) => `${day.date} 合格${day.qualified}个，采用${day.selected}个`).join('；')}`}
    >
      {[0, 0.5, 1].map((value) => (
        <g key={value}>
          <line
            x1={left}
            x2={width - right}
            y1={top + plotHeight * value}
            y2={top + plotHeight * value}
            className="chart-grid"
          />
          <text x={left - 8} y={top + plotHeight * value + 4} textAnchor="end">
            {Math.round(max * (1 - value))}
          </text>
        </g>
      ))}
      {data.map((day, index) => {
        const qualifiedHeight = (day.qualified / max) * plotHeight;
        const selectedHeight = (day.selected / max) * plotHeight;
        return (
          <g key={day.date}>
            <rect
              x={left + step * index + step * 0.18}
              y={top + plotHeight - qualifiedHeight}
              width={step * 0.28}
              height={qualifiedHeight}
              className={`chart-bar${index === data.length - 1 ? ' chart-bar-current' : ''}`}
            >
              <title>{`${day.date}：合格 ${day.qualified} 个事件`}</title>
            </rect>
            <rect
              x={left + step * index + step * 0.52}
              y={top + plotHeight - selectedHeight}
              width={step * 0.28}
              height={selectedHeight}
              className={`chart-bar chart-bar-selected${index === data.length - 1 ? ' chart-bar-current' : ''}`}
            >
              <title>{`${day.date}：日报采用 ${day.selected} 个事件`}</title>
            </rect>
            {chartLabels(data.length).includes(index) && (
              <text x={left + step * (index + 0.5)} y={height - 8} textAnchor="middle">
                {day.date.slice(5).replace('-', '/')}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function SubscriptionChart({ data }: { data: ChartData['subscriptions'] }) {
  const width = 720,
    height = 200,
    left = 38,
    right = 42,
    top = 20,
    bottom = 34;
  const plotWidth = width - left - right,
    plotHeight = height - top - bottom;
  const activityMax = Math.max(1, ...data.trend.map((day) => Math.max(day.added, day.cancelled)));
  const totalMax = Math.max(1, ...data.trend.map((day) => day.total));
  const step = plotWidth / data.trend.length;
  const points = data.trend
    .map(
      (day, index) =>
        `${left + step * (index + 0.5)},${top + plotHeight - (day.total / totalMax) * plotHeight}`,
    )
    .join(' ');
  return (
    <svg
      className="dashboard-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`订阅趋势：新增${data.added}，取消${data.cancelled}，净增长${data.net}，当前有效订阅${data.current}`}
    >
      {[0, 0.5, 1].map((value) => (
        <g key={value}>
          <line
            x1={left}
            x2={width - right}
            y1={top + plotHeight * value}
            y2={top + plotHeight * value}
            className="chart-grid"
          />
          <text x={left - 8} y={top + plotHeight * value + 4} textAnchor="end">
            {Number((activityMax * (1 - value)).toFixed(1))}
          </text>
          <text x={width - right + 8} y={top + plotHeight * value + 4}>
            {Number((totalMax * (1 - value)).toFixed(1))}
          </text>
        </g>
      ))}
      {data.trend.map((day, index) => (
        <g key={day.date}>
          {[
            { value: day.added, offset: 0.18, className: 'chart-bar' },
            { value: day.cancelled, offset: 0.52, className: 'chart-bar chart-bar-cancelled' },
          ].map((bar) => {
            const barHeight = (bar.value / activityMax) * plotHeight;
            return (
              <rect
                key={bar.className}
                x={left + step * index + step * bar.offset}
                y={top + plotHeight - barHeight}
                width={step * 0.28}
                height={barHeight}
                className={`${bar.className}${index === data.trend.length - 1 ? ' chart-bar-current' : ''}`}
              >
                <title>{`${day.date}：${bar.className.includes('cancelled') ? '取消' : '新增'} ${bar.value}`}</title>
              </rect>
            );
          })}
          {chartLabels(data.trend.length).includes(index) && (
            <text x={left + step * (index + 0.5)} y={height - 8} textAnchor="middle">
              {day.date.slice(5).replace('-', '/')}
            </text>
          )}
        </g>
      ))}
      <polyline points={points} className="subscription-total-line" />
    </svg>
  );
}

export function DashboardCharts({ data }: { data: ChartData }) {
  const contributionMax = Math.max(1, ...data.contributions.map((source) => source.selected));
  const metrics = [
    { label: '新增入库', value: data.summary.incoming, previous: data.previousSummary.incoming },
    { label: '筛选通过', value: data.summary.relevant, previous: data.previousSummary.relevant },
    { label: '合格事件', value: data.summary.qualified, previous: data.previousSummary.qualified },
    { label: '日报采用', value: data.summary.selected, previous: data.previousSummary.selected },
  ];
  const comparison = (current: number, previous: number) =>
    previous
      ? `较前期 ${current >= previous ? '+' : ''}${(((current - previous) / previous) * 100).toFixed(1)}%`
      : `前期 ${previous}`;
  return (
    <>
      <dl className="period-totals">
        {metrics.map((metric) => (
          <div key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>{metric.value}</dd>
            <small>{comparison(metric.value, metric.previous)}</small>
          </div>
        ))}
        <div>
          <dt>最终采用率</dt>
          <dd>{percent(data.summary.adoption)}</dd>
          <small>
            较前期 {data.summary.adoption - data.previousSummary.adoption >= 0 ? '+' : ''}
            {(data.summary.adoption - data.previousSummary.adoption).toFixed(1)} 个百分点
          </small>
        </div>
      </dl>
      <section className="overview-section" aria-labelledby="content-conversion">
        <div className="overview-section-heading">
          <h2 id="content-conversion">内容转化</h2>
          <span className="ranking-caption">资讯处理为文章口径，合格与采用为独立事件口径</span>
        </div>
        <dl className="conversion-steps">
          {[
            ['新增采集', data.summary.incoming, ''],
            [
              '筛选通过',
              data.summary.relevant,
              data.summary.incoming
                ? `${percent((data.summary.relevant / data.summary.incoming) * 100)} 通过`
                : '—',
            ],
            [
              '合格事件',
              data.summary.qualified,
              data.summary.relevant
                ? `${percent((data.summary.qualified / data.summary.relevant) * 100)} 合格`
                : '—',
            ],
            [
              '日报采用',
              data.summary.selected,
              data.summary.qualified
                ? `${percent((data.summary.selected / data.summary.qualified) * 100)} 采用`
                : '—',
            ],
          ].map(([label, value, rate]) => (
            <div key={String(label)}>
              <dt>{label}</dt>
              <dd>{value}</dd>
              <small>{rate}</small>
            </div>
          ))}
        </dl>
      </section>
      <div className="overview-columns dashboard-period-columns">
        <section className="overview-section" aria-labelledby="content-trend">
          <div className="overview-section-heading">
            <h2 id="content-trend">每日内容趋势</h2>
            <span className="chart-legend">
              <i />
              合格事件 <i className="selected" />
              日报采用
            </span>
          </div>
          <ContentTrend data={data.trend} />
        </section>
        <section className="overview-section" aria-labelledby="subscription-trend">
          <div className="overview-section-heading">
            <h2 id="subscription-trend">订阅趋势</h2>
            <Link href="/admin/subscriptions">订阅管理</Link>
          </div>
          <div className="subscription-summary">
            <span>
              期初 <strong>{data.subscriptions.start}</strong>
            </span>
            <span>
              新增 <strong>{data.subscriptions.added}</strong>
            </span>
            <span>
              取消 <strong>{data.subscriptions.cancelled}</strong>
            </span>
            <span>
              净增长 <strong>{data.subscriptions.net}</strong>
            </span>
            <span>
              当前 <strong>{data.subscriptions.current}</strong>
            </span>
          </div>
          <SubscriptionChart data={data.subscriptions} />
          <p className="chart-legend">
            <i />
            新增 <i className="cancelled" />
            取消 <i className="total" />
            有效总量
          </p>
        </section>
      </div>
      <section className="overview-section" aria-labelledby="section-performance">
        <div className="overview-section-heading">
          <h2 id="section-performance">栏目表现</h2>
          <Link href="/admin/publications">出刊管理</Link>
        </div>
        <div className="table-wrap">
          <table className="dashboard-section-table">
            <thead>
              <tr>
                <th>栏目</th>
                <th>候选事件</th>
                <th>日报采用</th>
                <th>留空天数</th>
                <th>异常天数</th>
              </tr>
            </thead>
            <tbody>
              {data.sections.map((section) => (
                <tr key={section.section}>
                  <td>{section.section}</td>
                  <td>{section.candidates}</td>
                  <td>{section.selected}</td>
                  <td>{section.empty_days}</td>
                  <td className={section.error_days ? 'overview-problem' : undefined}>
                    {section.error_days}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.sections.length && <p className="ranking-empty">本周期暂无出刊记录。</p>}
      </section>
      <div className="overview-rankings">
        <section className="overview-section" aria-labelledby="contribution-ranking">
          <div className="overview-section-heading">
            <h2 id="contribution-ranking">信源有效贡献 Top 5</h2>
          </div>
          <p className="ranking-caption">被已发布日报引用的独立事件数</p>
          <ol className="source-ranking">
            {data.contributions.map((source, index) => (
              <li key={source.id}>
                <div className="ranking-row">
                  <span className="ranking-index">{index + 1}</span>
                  <Link
                    href={`/admin/sources/monitor?source=${source.id}&view=period&days=${data.days}`}
                  >
                    {source.name}
                  </Link>
                  <span className="ranking-value">
                    {source.selected}
                    <small> 个事件</small>
                  </span>
                </div>
                <div className="ranking-track" aria-hidden="true">
                  <span style={{ width: `${(source.selected / contributionMax) * 100}%` }} />
                </div>
              </li>
            ))}
          </ol>
          {!data.contributions.length && <p className="ranking-empty">暂无日报引用记录。</p>}
        </section>
        <section className="overview-section" aria-labelledby="low-efficiency-sources">
          <div className="overview-section-heading">
            <h2 id="low-efficiency-sources">低效信源</h2>
            <Link href="/admin/sources/monitor">信源监控</Link>
          </div>
          <p className="ranking-caption">重复率不低于 80%，或采集较多但日报零采用</p>
          <ul className="efficiency-list">
            {data.lowEfficiency.map((source) => (
              <li key={source.id}>
                <Link
                  href={`/admin/sources/monitor?source=${source.id}&view=period&days=${data.days}`}
                >
                  {source.name}
                </Link>
                <span>
                  重复 {percent((source.repeated / source.observed) * 100)} · 首次发现{' '}
                  {source.discovered} · 采用 {source.selected}
                </span>
              </li>
            ))}
          </ul>
          {!data.lowEfficiency.length && <p className="ranking-empty">暂无明显低效信源。</p>}
        </section>
      </div>
      <div className="overview-runtime">
        <span>
          采集成功率{' '}
          {data.runtime.collectionRate === null ? '—' : percent(data.runtime.collectionRate)}
          {' · '}处理失败 {data.runtime.failed} 篇{' · '}模型调用 {data.runtime.calls} 次
          {data.runtime.callsPerSelected !== null &&
            ` · 每个采用事件 ${data.runtime.callsPerSelected.toFixed(1)} 次`}
        </span>
        <Link href="/admin/articles">任务管理</Link>
      </div>
    </>
  );
}
