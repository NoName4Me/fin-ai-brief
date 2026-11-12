import { pool } from './db.ts';
import { localDate } from './periods.ts';
import { getSettings } from './settings.ts';
import { ratingForEditorial } from './editorial.ts';
import type { SourceDiscovery, SourceMetric } from './source-metrics.ts';

type Discovery = Pick<
  SourceDiscovery,
  | 'source_id'
  | 'url'
  | 'inserted'
  | 'state'
  | 'event_id'
  | 'first_seen_at'
  | 'qualified'
  | 'selected'
  | 'highlight'
>;
type Metric = Pick<
  SourceMetric,
  'id' | 'name' | 'enabled' | 'discovered' | 'selected' | 'highlights'
>;

export type DashboardPeriod = 7 | 30;
type Range = { start: Date; end: Date };

export function dashboardRange(days: DashboardPeriod, now = new Date()): Range {
  const end = new Date(`${localDate(now)}T00:00:00+08:00`);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { start, end };
}

function summarize(discoveries: Discovery[]) {
  const events = (items: Discovery[]) =>
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

function dailyTrend(range: Range, discoveries: Discovery[]) {
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
    const eventSet = (predicate: (item: Discovery) => boolean) =>
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

export async function subscriptionTrend(range: Range, now: Date) {
  const [{ rows }, { rows: confirmations }] = await Promise.all([
    pool.query<{ email: string; subscribed_at: Date; unsubscribed_at: Date | null }>(
      'SELECT email,subscribed_at,unsubscribed_at FROM subscriptions',
    ),
    pool.query<{
      email: string;
      requested_at: Date;
      expires_at: Date;
      confirmed_at: Date | null;
    }>('SELECT email,requested_at,expires_at,confirmed_at FROM subscription_confirmations'),
  ]);
  const activeAt = (at: Date) =>
    rows.filter(
      (row) => row.subscribed_at < at && (!row.unsubscribed_at || row.unsubscribed_at >= at),
    ).length;
  const activeFor = (email: string, at: Date) =>
    rows.some(
      (row) =>
        row.email === email &&
        row.subscribed_at < at &&
        (!row.unsubscribed_at || row.unsubscribed_at >= at),
    );
  const confirmationStateAt = (at: Date) => {
    const unconfirmed = confirmations.filter((row) => !row.confirmed_at || row.confirmed_at > at);
    return {
      pending: unconfirmed.filter(
        (row) => row.requested_at < at && row.expires_at > at && !activeFor(row.email, at),
      ).length,
      expired: unconfirmed.filter(
        (row) => row.requested_at < at && row.expires_at <= at && !activeFor(row.email, at),
      ).length,
    };
  };
  const trend: {
    date: string;
    added: number;
    cancelled: number;
    total: number;
    pending: number;
    expired: number;
    unconfirmed: number;
  }[] = [];
  for (let start = new Date(range.start); start < range.end;) {
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    const stateAt = end > now ? now : end;
    const unconfirmed = confirmationStateAt(stateAt);
    trend.push({
      date: localDate(start),
      added: rows.filter((row) => row.subscribed_at >= start && row.subscribed_at < end).length,
      cancelled: rows.filter(
        (row) => row.unsubscribed_at && row.unsubscribed_at >= start && row.unsubscribed_at < end,
      ).length,
      total: activeAt(stateAt),
      ...unconfirmed,
      unconfirmed: unconfirmed.pending + unconfirmed.expired,
    });
    start = end;
  }
  const added = trend.reduce((sum, day) => sum + day.added, 0);
  const cancelled = trend.reduce((sum, day) => sum + day.cancelled, 0);
  const currentConfirmationState = confirmationStateAt(now);
  return {
    trend,
    added,
    cancelled,
    net: added - cancelled,
    current: activeAt(now),
    start: activeAt(range.start),
    pending: currentConfirmationState.pending,
    expired: currentConfirmationState.expired,
    unconfirmed: currentConfirmationState.pending + currentConfirmationState.expired,
  };
}

function sourceRows(metrics: Metric[]) {
  const contributions = metrics
    .filter((source) => source.selected > 0)
    .sort(
      (a, b) =>
        b.selected - a.selected || b.highlights - a.highlights || a.name.localeCompare(b.name),
    )
    .slice(0, 5)
    .map(({ id, name, selected }) => ({ id, name, selected }));
  const lowEfficiency = metrics
    .filter((source) => source.enabled && source.discovered >= 10 && source.selected === 0)
    .sort((a, b) => b.discovered - a.discovered)
    .slice(0, 5)
    .map((source) => ({
      id: source.id,
      name: source.name,
      discovered: source.discovered,
      selected: source.selected,
    }));
  return { contributions, lowEfficiency };
}

// The dashboard needs counts and event IDs, not article bodies, editions or peer lists.
// Read both comparison periods once and expand published references once per query.
export async function dashboardContent(days: DashboardPeriod = 7, now = new Date()) {
  const range = dashboardRange(days, now);
  const previousStart = new Date(range.start.getTime() - days * 86400_000);
  const config = await getSettings();
  const [observations, sources] = await Promise.all([
    pool.query<
      Omit<Discovery, 'qualified'> & Pick<SourceDiscovery, 'assessment' | 'rating_rules' | 'score'>
    >(
      `WITH failed_discoveries AS MATERIALIZED (
        SELECT DISTINCT source_id,url FROM collection_items WHERE outcome='failed'
      ), edition_refs AS MATERIALIZED (
        SELECT i->>'eventId' event_id,ref->>'url' url,max(b.published_at) published_at,
          max(b.published_at) FILTER(WHERE EXISTS(
            SELECT 1 FROM jsonb_array_elements(coalesce(b.published->'highlights','[]'::jsonb)) h
            WHERE h->>'eventId'=i->>'eventId')) highlight_at
        FROM briefs b
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(b.published->'items','[]'::jsonb)) i
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(i->'sources','[]'::jsonb)) ref
        WHERE b.kind='daily' AND b.published IS NOT NULL
        GROUP BY i->>'eventId',ref->>'url'
      )
      SELECT d.source_id,d.url,d.inserted,d.first_seen_at,a.event_id,a.assessment,e.score,
        coalesce(a.state,CASE WHEN failed.url IS NOT NULL THEN 'failed' ELSE 'removed' END) state,
        (SELECT p.result->'ratingRules' FROM processing_steps p
          WHERE p.subject='article:'||a.id::text AND p.stage='validate' AND p.state='succeeded'
          ORDER BY p.finished_at DESC LIMIT 1) rating_rules,
        coalesce(ref.published_at>=d.first_seen_at,false) selected,
        coalesce(ref.highlight_at>=d.first_seen_at,false) highlight
      FROM source_discoveries d
      LEFT JOIN articles a ON a.url=d.url
      LEFT JOIN failed_discoveries failed ON failed.source_id=d.source_id AND failed.url=d.url
      LEFT JOIN events e ON e.id=a.event_id
      LEFT JOIN edition_refs ref ON ref.event_id=a.event_id::text AND ref.url=d.url
      WHERE d.first_seen_at>=$1 AND d.first_seen_at<$2
      ORDER BY d.first_seen_at,d.source_id,d.url`,
      [previousStart, range.end],
    ),
    pool.query<Pick<Metric, 'id' | 'name' | 'enabled'>>(
      'SELECT id,name,enabled FROM sources ORDER BY sort_order,created_at,id',
    ),
  ]);
  const rows: Discovery[] = observations.rows.map((row) => ({
    ...row,
    qualified:
      row.state === 'processed' &&
      Number(row.score) > 0 &&
      (ratingForEditorial(
        {
          assessment: row.assessment,
          ...(row.rating_rules ? { ratingRules: row.rating_rules } : {}),
        },
        config.ratingRules,
      ) ?? 0) >= config.candidateRating,
  }));
  const current = rows.filter((row) => row.first_seen_at >= range.start);
  const previous = rows.filter((row) => row.first_seen_at < range.start);
  const bySource = new Map<string, Discovery[]>();
  for (const row of current) {
    const items = bySource.get(row.source_id) ?? [];
    items.push(row);
    bySource.set(row.source_id, items);
  }
  const eventCount = (items: Discovery[]) =>
    new Set(items.flatMap((row) => (row.event_id ? [row.event_id] : []))).size;
  const metrics = sources.rows.map((source) => {
    const items = bySource.get(source.id) ?? [];
    return {
      ...source,
      discovered: items.length,
      selected: eventCount(items.filter((row) => row.selected)),
      highlights: eventCount(items.filter((row) => row.highlight)),
    };
  });
  return {
    days,
    range: { start: localDate(range.start), end: localDate(now) },
    summary: summarize(current),
    previousSummary: summarize(previous),
    trend: dailyTrend(range, current),
    ...sourceRows(metrics),
    failed: current.filter((row) => row.state === 'failed').length,
  };
}

export async function dashboardSections(range: Range) {
  const { rows } = await pool.query<{
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
  );
  return rows;
}

export async function dashboardRuntime(range: Range) {
  const [runs, calls] = await Promise.all([
    pool.query<{ succeeded: number; failed: number }>(
      `SELECT count(*) FILTER(WHERE r.state='succeeded')::int succeeded,
        count(*) FILTER(WHERE r.state='failed')::int failed
      FROM collection_runs r JOIN sources s ON s.id=r.source_id
      WHERE r.started_at>=$1 AND r.started_at<$2`,
      [range.start, range.end],
    ),
    pool.query<{ calls: number }>(
      'SELECT coalesce(sum(greatest(api_attempts,1)),0)::int calls FROM model_calls WHERE created_at>=$1 AND created_at<$2',
      [range.start, range.end],
    ),
  ]);
  const { succeeded, failed } = runs.rows[0];
  return {
    collectionRate: succeeded + failed ? (succeeded / (succeeded + failed)) * 100 : null,
    calls: calls.rows[0].calls,
  };
}

export async function dashboardCharts(days: DashboardPeriod = 7, now = new Date()) {
  const range = dashboardRange(days, now);
  const [content, subscriptions, sections, runtime] = await Promise.all([
    dashboardContent(days, now),
    subscriptionTrend(range, now),
    dashboardSections(range),
    dashboardRuntime(range),
  ]);
  const { failed, ...data } = content;
  return {
    ...data,
    subscriptions,
    sections,
    runtime: {
      ...runtime,
      failed,
      callsPerSelected: content.summary.selected ? runtime.calls / content.summary.selected : null,
    },
  };
}
