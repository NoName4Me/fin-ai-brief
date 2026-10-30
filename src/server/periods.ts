import type { Kind, Settings } from './types.ts';
export function localDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}
export function validDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
type Schedule = { weeklyDay?: number; monthlyDay?: number };
function monthDate(year: number, month: number, requested: number) {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(requested, last))).toISOString().slice(0, 10);
}
function isScheduled(kind: Kind, date: string, config: Schedule) {
  const day = new Date(date);
  if (kind === 'weekly') return day.getUTCDay() === (config.weeklyDay ?? 1);
  if (kind === 'monthly')
    return date === monthDate(day.getUTCFullYear(), day.getUTCMonth(), config.monthlyDay ?? 1);
  return true;
}
export function rangeFor(kind: Kind, date: string, time: string, config: Schedule = {}) {
  if (!validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new Error('无效日期或出刊时间');
  if (!isScheduled(kind, date, config)) throw new Error('出刊日期不符合当前出刊规则');
  const end = new Date(`${date}T${time}:00+08:00`);
  let start = new Date(end);
  if (kind === 'daily') start.setUTCDate(start.getUTCDate() - 1);
  if (kind === 'weekly') start.setUTCDate(start.getUTCDate() - 7);
  if (kind === 'monthly') {
    const day = new Date(date);
    const previous = monthDate(day.getUTCFullYear(), day.getUTCMonth() - 1, config.monthlyDay ?? 1);
    start = new Date(`${previous}T${time}:00+08:00`);
  }
  return { start, end };
}
export function publicationCycle(now: Date, dailyTime: string) {
  const today = rangeFor('daily', localDate(now), dailyTime);
  const start = now >= today.end ? today.end : today.start;
  return { start, end: now, previousStart: new Date(start.getTime() - 86400000) };
}
export function duePeriods(
  now: Date,
  setting:
    | string
    | (Pick<Settings, 'dailyTime' | 'weeklyTime' | 'monthlyTime' | 'startDate'> &
        Schedule &
        Partial<Pick<Settings, 'dailyEnabled' | 'weeklyEnabled' | 'monthlyEnabled'>>),
): { kind: Kind; date: string }[] {
  const date = localDate(now);
  const config =
    typeof setting === 'string'
      ? { dailyTime: setting, weeklyTime: setting, monthlyTime: setting, startDate: '0001-01-01' }
      : setting;
  if (date < config.startDate) return [];
  const due: { kind: Kind; date: string }[] = [];
  for (const kind of ['daily', 'weekly', 'monthly'] as const) {
    if (typeof setting !== 'string' && setting[`${kind}Enabled`] === false) continue;
    const time =
      kind === 'daily'
        ? config.dailyTime
        : kind === 'weekly'
          ? (config.weeklyTime ?? config.dailyTime)
          : (config.monthlyTime ?? config.dailyTime);
    if (now < new Date(`${date}T${time}:00+08:00`) || !isScheduled(kind, date, config)) continue;
    due.push({ kind, date });
  }
  return due;
}
export function preCollectionCutoff(now: Date, dailyTime: string) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyTime)) throw new Error('无效出刊时间');
  const todayPublication = new Date(`${localDate(now)}T${dailyTime}:00+08:00`);
  for (const publicationAt of [
    todayPublication,
    new Date(todayPublication.getTime() + 86400_000),
  ]) {
    if (now >= new Date(publicationAt.getTime() - 3600_000) && now < publicationAt)
      return new Date(publicationAt.getTime() - 2 * 3600_000);
  }
  return null;
}
export function backfillPeriods(start: string, end: string, kind: Kind, config: Schedule = {}) {
  if (!validDate(start) || !validDate(end) || start > end) throw new Error('补刊日期范围无效');
  const result: { kind: Kind; date: string }[] = [];
  for (let day = new Date(start); day <= new Date(end); day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    if (!isScheduled(kind, date, config)) continue;
    result.push({ kind, date });
    if (result.length > 100) throw new Error('单次最多补刊100期，请缩短范围');
  }
  return result;
}
export const dateLabel = (date: string | Date) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(date));
export const timeLabel = (date: string | Date) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(date));
