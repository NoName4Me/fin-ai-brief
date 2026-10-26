import type { BriefContent, Kind } from './types.ts';
import { localDate } from './periods.ts';
export function weekday(date: string) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(
    new Date(`${date}T12:00:00+08:00`),
  );
}
export function sectionAnchor(industryId: string, section: string) {
  return `section-${industryId}-${section}`;
}
export function sectionLinks(content: BriefContent, industry: { id: string; sections: string[] }) {
  const items = content.items.filter((item) => item.industryId === industry.id);
  return [...new Set([...industry.sections, ...items.map((item) => item.section)])]
    .filter((section) => items.some((item) => item.section === section))
    .map((section) => ({ name: section, anchor: sectionAnchor(industry.id, section) }));
}
export function groupIssues<
  T extends { periodDate: string; content?: Pick<BriefContent, 'rangeStart'> | null },
>(issues: T[], kind: Kind, now = new Date()) {
  const today = localDate(now);
  const currentYear = today.slice(0, 4);
  const groups = new Map<string, T[]>();
  for (const issue of [...issues].sort((a, b) => b.periodDate.localeCompare(a.periodDate))) {
    const month =
      kind === 'monthly' && issue.content?.rangeStart
        ? localDate(new Date(issue.content.rangeStart))
        : issue.periodDate;
    const key = month.slice(0, kind === 'monthly' ? 4 : 7);
    const group = groups.get(key) ?? [];
    group.push(issue);
    groups.set(key, group);
  }
  return [...groups].map(([key, items]) => ({
    key,
    label: kind === 'monthly' ? `${key}年` : `${key.slice(0, 4)}年${Number(key.slice(5))}月`,
    open:
      kind === 'monthly'
        ? key === currentYear || key === groups.keys().next().value
        : key === today.slice(0, 7),
    items,
  }));
}

export function sectionGroups(items: BriefContent['items'], sections: string[]) {
  return [...new Set([...sections, ...items.map((item) => item.section)])]
    .map((name) => ({ name, items: items.filter((item) => item.section === name) }))
    .filter((group) => group.items.length);
}

export function editionCalendar(kind: Kind, date: string, content: BriefContent) {
  const start = localDate(new Date(content.rangeStart));
  // 周刊范围是左闭右开；日期标记展示范围内完整日期，周次按最后一天的ISO周计算。
  const last = localDate(new Date(new Date(content.rangeEnd).getTime() - 86_400_000));
  const weekDay = new Date(`${last}T00:00:00Z`);
  weekDay.setUTCDate(weekDay.getUTCDate() + 4 - (weekDay.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(weekDay.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((weekDay.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return {
    top:
      kind === 'monthly'
        ? `${start.slice(0, 4)}年`
        : kind === 'weekly'
          ? `${start.slice(0, 4)}年${Number(start.slice(5, 7))}月`
          : `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月`,
    number:
      kind === 'monthly'
        ? String(Number(start.slice(5, 7)))
        : kind === 'weekly'
          ? String(week)
          : date.slice(-2),
    detail:
      kind === 'weekly'
        ? `${start.slice(5).replace('-', '.')}-${last.slice(5).replace('-', '.')}`
        : kind === 'daily'
          ? weekday(date).replace('周', '星期')
          : '',
    weekYear: weekDay.getUTCFullYear(),
  };
}
