import { Suspense, type ReactNode } from 'react';
import {
  dashboardContent,
  dashboardRange,
  dashboardRuntime,
  dashboardSections,
  subscriptionTrend,
  type DashboardPeriod,
} from '../server/dashboard-charts.ts';
import {
  DashboardContentMetrics,
  DashboardContentTrend,
  DashboardRuntime,
  DashboardSections,
  DashboardSources,
  DashboardSubscriptions,
} from './dashboard-charts.tsx';

export function DashboardLoading({ label }: { label: string }) {
  return (
    <section className="overview-section dashboard-loading" aria-busy="true" aria-label={label}>
      <h2>{label}</h2>
      <p role="status">正在加载…</p>
      <div className="dashboard-loading-placeholder" aria-hidden="true" />
    </section>
  );
}

async function Resolved<T>({
  data,
  children,
}: {
  data: Promise<T>;
  children: (value: T) => ReactNode;
}) {
  return children(await data);
}

export function DashboardPanels({ days, now }: { days: DashboardPeriod; now: Date }) {
  const range = dashboardRange(days, now);
  // Share content statistics between panels; unrelated modules can finish independently.
  const content = dashboardContent(days, now);
  const subscriptions = subscriptionTrend(range, now);
  const sections = dashboardSections(range);
  const runtime = Promise.all([dashboardRuntime(range), content]).then(([value, data]) => ({
    ...value,
    failed: data.failed,
    callsPerSelected: data.summary.selected ? value.calls / data.summary.selected : null,
  }));
  return (
    <>
      <Suspense fallback={<DashboardLoading label="内容转化" />}>
        <Resolved data={content}>{(data) => <DashboardContentMetrics data={data} />}</Resolved>
      </Suspense>
      <div className="overview-columns dashboard-period-columns">
        <Suspense fallback={<DashboardLoading label="每日内容趋势" />}>
          <Resolved data={content}>{(data) => <DashboardContentTrend data={data} />}</Resolved>
        </Suspense>
        <Suspense fallback={<DashboardLoading label="订阅趋势" />}>
          <Resolved data={subscriptions}>
            {(data) => <DashboardSubscriptions data={{ subscriptions: data }} />}
          </Resolved>
        </Suspense>
      </div>
      <Suspense fallback={<DashboardLoading label="栏目表现" />}>
        <Resolved data={sections}>
          {(data) => <DashboardSections data={{ sections: data }} />}
        </Resolved>
      </Suspense>
      <Suspense fallback={<DashboardLoading label="信源贡献" />}>
        <Resolved data={content}>{(data) => <DashboardSources data={data} />}</Resolved>
      </Suspense>
      <Suspense fallback={<DashboardLoading label="运行与成本" />}>
        <Resolved data={runtime}>
          {(data) => <DashboardRuntime data={{ runtime: data }} />}
        </Resolved>
      </Suspense>
    </>
  );
}
