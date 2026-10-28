import Link from 'next/link';
import type { dashboardCharts } from '../server/dashboard-charts.ts';
type ChartData = Awaited<ReturnType<typeof dashboardCharts>>;
export function DashboardCharts({ data }: { data: ChartData }) {
  const contributionMax = Math.max(1, ...data.contributions.map((s) => s.selected));
  const incomingMax = Math.max(
    2,
    Math.ceil(Math.max(0, ...data.trend.map((d) => d.incoming)) / 2) * 2,
  );
  const width = 700,
    height = 160,
    left = 35,
    right = 12,
    top = 20,
    bottom = 30;
  const plotWidth = width - left - right,
    plotHeight = height - top - bottom;
  const step = plotWidth / data.trend.length;
  return (
    <>
      <div className="overview-rankings">
        <section className="overview-section" aria-labelledby="contribution-ranking">
          <div className="overview-section-heading">
            <h2 id="contribution-ranking">
              日报有效贡献 Top 5 <small>近30天</small>
            </h2>
          </div>
          <p className="ranking-caption">被已发布日报引用的独立事件数</p>
          <ol className="source-ranking">
            {data.contributions.map((s, index) => (
              <li key={s.id}>
                <div className="ranking-row">
                  <span className="ranking-index">{index + 1}</span>
                  <Link href={`/admin/sources?detail=${s.id}`}>{s.name}</Link>
                  <span className="ranking-value">
                    {s.selected}
                    <small> 个事件</small>
                  </span>
                </div>
                <div className="ranking-track" aria-hidden="true">
                  <span style={{ width: `${(s.selected / contributionMax) * 100}%` }} />
                </div>
              </li>
            ))}
          </ol>
          {!data.contributions.length && <p className="ranking-empty">暂无日报引用记录。</p>}
        </section>
        <section className="overview-section" aria-labelledby="overlap-ranking">
          <div className="overview-section-heading">
            <h2 id="overlap-ranking">
              信源重合 Top 3 <small>近30天</small>
            </h2>
            <Link href="/admin/sources/monitor">信源监控</Link>
          </div>
          <p className="ranking-caption">两两比较，按较小信源被覆盖的比例排序</p>
          <ol className="source-ranking source-ranking-overlap source-pair-ranking">
            {data.overlap.map((pair, index) => (
              <li key={`${pair.left_id}:${pair.right_id}`}>
                <div className="ranking-pair-summary">
                  <span className="ranking-index">{index + 1}</span>
                  <span>共同 {pair.shared} 个事件</span>
                </div>
                {[
                  {
                    id: pair.left_id,
                    name: pair.left_name,
                    events: pair.left_events,
                    rate: pair.leftRate,
                  },
                  {
                    id: pair.right_id,
                    name: pair.right_name,
                    events: pair.right_events,
                    rate: pair.rightRate,
                  },
                ].map((source) => (
                  <div className="ranking-pair-source" key={source.id}>
                    <div className="ranking-row">
                      <Link href={`/admin/sources?detail=${source.id}`}>{source.name}</Link>
                      <span className="ranking-value">
                        {source.rate.toFixed(1)}%{' '}
                        <small>
                          ({pair.shared}/{source.events})
                        </small>
                      </span>
                    </div>
                    <div className="ranking-track" aria-hidden="true">
                      <span style={{ width: `${source.rate}%` }} />
                    </div>
                  </div>
                ))}
              </li>
            ))}
          </ol>
          {!data.overlap.length && <p className="ranking-empty">暂无信源之间的重合事件。</p>}
        </section>
      </div>
      <section className="overview-section" aria-labelledby="incoming-trend">
        <div className="overview-section-heading">
          <h2 id="incoming-trend">
            资讯入库趋势 <small>近14天</small>
          </h2>
          <span className="ranking-caption">
            共 {data.trend.reduce((sum, d) => sum + d.incoming, 0)} 篇
          </span>
        </div>
        <svg
          className="incoming-chart"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`近14天每日入库篇数：${data.trend.map((d) => `${d.date} ${d.incoming}篇`).join('；')}`}
        >
          {[0, 0.5, 1].map((v) => (
            <g key={v}>
              <line
                x1={left}
                x2={width - right}
                y1={top + plotHeight * v}
                y2={top + plotHeight * v}
                className="chart-grid"
              />
              <text x={left - 8} y={top + plotHeight * v + 4} textAnchor="end">
                {Math.round(incomingMax * (1 - v))}
              </text>
            </g>
          ))}
          {data.trend.map((d, index) => {
            const barHeight = (d.incoming / incomingMax) * plotHeight;
            return (
              <g key={d.date}>
                <rect
                  x={left + step * index + step * 0.2}
                  y={top + plotHeight - barHeight}
                  width={step * 0.6}
                  height={barHeight}
                  className="chart-bar"
                >
                  <title>{`${d.date}：${d.incoming} 篇`}</title>
                </rect>
                {[0, 6, 13].includes(index) && (
                  <text x={left + step * (index + 0.5)} y={height - 7} textAnchor="middle">
                    {d.date.slice(5).replace('-', '/')}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </section>
    </>
  );
}
