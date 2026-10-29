import { pool } from './db.ts';
import { localDate } from './periods.ts';
import { sourceQualityData, type SourceDiscovery, type SourceMetric } from './source-metrics.ts';

export type DashboardPeriod = 7 | 30;
type Range = { start: Date; end: Date };

export function dashboardRange(days: DashboardPeriod, now = new Date()): Range {
  const end = new Date(`${localDate(now)}T00:00:00+08:00`);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { start, end };
}

function summarize(discoveries: SourceDiscovery[]) {
  const events = (items: SourceDiscovery[]) =>
    new Set(items.flatMap((item) => (item.event_id ? [item.event_id] : []))).size;
  const qualified = discoveries.filter((item) => item.qualified);
  const selected = discoveries.filter((item) => item.selected);
  return {
    incoming: discoveries.filter((item) => item.inserted).length,
    relevant: new Set(
      discoveries.filter((item) => item.state === 'processed').map((item) => item.url),
    ).size,
    qualified: events(qualified),
    selected: events(selected),
    adoption: events(qualified) ? (events(selected) / events(qualified)) * 100 : 0,
  };
}

function dailyTrend(range: Range, discoveries: SourceDiscovery[]) {
  const firstSeen = new Map<string, Date>();
  for (const item of discoveries)
    if (
      item.event_id &&
      (!firstSeen.has(item.event_id) || item.first_seen_at < firstSeen.get(item.event_id)!)
    )
      firstSeen.set(item.event_id, item.first_seen_at);
  const days: { date: string; start: Date; end: Date }[] = [];
  for (let start = new Date(range.start); start < range.end;) {
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    days.push({ date: localDate(start), start: new Date(start), end });
    start = end;
  }
  return days.map((day) => {
    const eventSet = (predicate: (item: SourceDiscovery) => boolean) =>
      new Set(
        discoveries.flatMap((item) =>
          item.event_id &&
          predicate(item) &&
          firstSeen.get(item.event_id)! >= day.start &&
          firstSeen.get(item.event_id)! < day.end
            ? [item.event_id]
            : [],
        ),
      ).size;
    return {
      date: day.date,
      qualified: eventSet((item) => item.qualified),
      selected: eventSet((item) => item.selected),
    };
  });
}

async function subscriptionTrend(range: Range, now: Date) {
  const { rows } = await pool.query<{ subscribed_at: Date; unsubscribed_at: Date | null }>(
    'SELECT subscribed_at,unsubscribed_at FROM subscriptions',
  );
  const activeAt = (at: Date) =>
    rows.filter(
      (row) => row.subscribed_at < at && (!row.unsubscribed_at || row.unsubscribed_at >= at),
    ).length;
  const trend: { date: string; added: number; cancelled: number; total: number }[] = [];
  for (let start = new Date(range.start); start < range.end;) {
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    trend.push({
      date: localDate(start),
      added: rows.filter((row) => row.subscribed_at >= start && row.subscribed_at < end).length,
      cancelled: rows.filter(
        (row) => row.unsubscribed_at && row.unsubscribed_at >= start && row.unsubscribed_at < end,
      ).length,
      total: activeAt(end),
    });
    start = end;
  }
  const added = trend.reduce((sum, day) => sum + day.added, 0);
  const cancelled = trend.reduce((sum, day) => sum + day.cancelled, 0);
  return {
    trend,
    added,
    cancelled,
    net: added - cancelled,
    current: activeAt(now),
    start: activeAt(range.start),
  };
}

function sourceRows(metrics: SourceMetric[]) {
  const contributions = metrics
    .filter((source) => source.selected > 0)
    .sort(
      (a, b) =>
        b.selected - a.selected || b.highlights - a.highlights || a.name.localeCompare(b.name),
    )
    .slice(0, 5)
    .map(({ id, name, selected }) => ({ id, name, selected }));
  const lowEfficiency = metrics
    .filter(
      (source) =>
        source.enabled &&
        source.observed_items >= 10 &&
        ((source.discovered >= 10 && source.selected === 0) ||
          source.repeated_items / source.observed_items >= 0.8),
    )
    .sort(
      (a, b) =>
        b.repeated_items / b.observed_items - a.repeated_items / a.observed_items ||
        b.discovered - a.discovered,
    )
    .slice(0, 5)
    .map((source) => ({
      id: source.id,
      name: source.name,
      discovered: source.discovered,
      selected: source.selected,
      repeated: source.repeated_items,
      observed: source.observed_items,
    }));
  return { contributions, lowEfficiency };
}

export async function dashboardCharts(days: DashboardPeriod = 7, now = new Date()) {
  const range = dashboardRange(days, now);
  const previousRange = {
    start: new Date(range.start.getTime() - days * 86400_000),
    end: range.start,
  };
  const [current, previous, subscriptions, sections, modelCalls] = await Promise.all([
    sourceQualityData(days, undefined, now, range),
    sourceQualityData(days, undefined, now, previousRange),
    subscriptionTrend(range, now),
    pool.query<{
      section: string;
      candidates: number;
      selected: number;
      empty_days: number;
      error_days: number;
    }>(
      `SELECT section,sum(candidate_count)::int candidates,sum(selected_count)::int selected,
      count(*) FILTER(WHERE status='skipped')::int empty_days,
      count(*) FILTER(WHERE status='error')::int error_days
      FROM edition_runs WHERE period_date>=$1::date AND period_date<$2::date
      GROUP BY section ORDER BY max(period_date) DESC,section`,
      [localDate(range.start), localDate(range.end)],
    ),
    pool.query<{ calls: number }>(
      'SELECT coalesce(sum(greatest(api_attempts,1)),0)::int calls FROM model_calls WHERE created_at>=$1 AND created_at<$2',
      [range.start, range.end],
    ),
  ]);
  const summary = summarize(current.discoveries);
  const previousSummary = summarize(previous.discoveries);
  const succeeded = current.metrics.reduce((sum, source) => sum + source.succeeded_runs, 0);
  const failed = current.metrics.reduce((sum, source) => sum + source.failed_runs, 0);
  return {
    days,
    range: { start: localDate(range.start), end: localDate(now) },
    summary,
    previousSummary,
    trend: dailyTrend(range, current.discoveries),
    subscriptions,
    ...sourceRows(current.metrics),
    sections: sections.rows,
    runtime: {
      collectionRate: succeeded + failed ? (succeeded / (succeeded + failed)) * 100 : null,
      failed: current.metrics.reduce((sum, source) => sum + source.failed, 0),
      calls: modelCalls.rows[0].calls,
      callsPerSelected: summary.selected ? modelCalls.rows[0].calls / summary.selected : null,
    },
  };
}
