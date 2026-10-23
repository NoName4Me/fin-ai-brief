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
export function groupIssues<T extends { periodDate: string }>(
  issues: T[],
  kind: Kind,
  now = new Date(),
) {
  const today = localDate(now);
  const currentYear = today.slice(0, 4);
  const groups = new Map<string, T[]>();
  for (const issue of [...issues].sort((a, b) => b.periodDate.localeCompare(a.periodDate))) {
    if (kind === 'monthly' && !issue.periodDate.startsWith(currentYear)) continue;
    const key = issue.periodDate.slice(0, kind === 'monthly' ? 4 : 7);
    const group = groups.get(key) ?? [];
    group.push(issue);
    groups.set(key, group);
  }
  return [...groups].map(([key, items]) => ({
    key,
    label: kind === 'monthly' ? `${key}年` : `${key.slice(0, 4)}年${Number(key.slice(5))}月`,
    open: kind === 'monthly' || key === today.slice(0, 7),
    items,
  }));
}
