import Link from 'next/link';
import { listPublished } from '../server/publication.ts';
import { kindNames, type Kind } from '../server/types.ts';
import { editionCalendar, groupIssues, weekday } from '../server/brief-presentation.ts';
export async function ReaderShell({
  children,
  kind = 'daily',
  currentId,
}: {
  children: React.ReactNode;
  kind?: Kind;
  currentId?: string;
}) {
  const groups = groupIssues(await listPublished(kind), kind);
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="简报归档">
        <nav className="editions" aria-label="简报类型">
          {Object.entries(kindNames).map(([key, label]) => (
            <Link key={key} href={`/?kind=${key}`} aria-current={kind === key ? 'page' : undefined}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="issue-groups">
          {groups.map((group) => (
            <details className="issue-group" key={group.key} open={group.open}>
              <summary>{group.label}</summary>
              {group.items.map((issue) => {
                const calendar = issue.content
                  ? editionCalendar(kind, issue.periodDate, issue.content)
                  : null;
                const [weekStart, weekEnd] = calendar?.detail.split('-') ?? [];
                return (
                  <Link
                    key={issue.id}
                    href={`/briefs/${issue.id}`}
                    className={`period-link ${issue.id === currentId ? 'current' : ''}`}
                    aria-current={issue.id === currentId ? 'page' : undefined}
                  >
                    <div
                      className={`period-calendar ${kind === 'weekly' ? 'period-calendar-weekly' : ''}`}
                    >
                      {kind === 'weekly' && <span className="period-range-start">{weekStart}</span>}
                      <div className="period-day">
                        {calendar?.number ?? issue.periodDate.slice(-2)}
                      </div>
                      {kind === 'weekly' ? (
                        <span className="period-range-end">{weekEnd}</span>
                      ) : (
                        <div className="period-month">
                          {kind === 'monthly' ? '月' : weekday(issue.periodDate)}
                        </div>
                      )}
                    </div>
                    <div className="period-name">{issue.content?.title ?? '未命名简报'}</div>
                  </Link>
                );
              })}
            </details>
          ))}
        </div>
        {!groups.length && (
          <p className="muted">{kind === 'monthly' ? '暂无正式月报' : '暂无正式出刊'}</p>
        )}
        <div className="side-footer">
          <Link href="/archive">查看历史简报</Link>
          <Link href="/admin">管理端</Link>
        </div>
      </aside>
      <main className="main">
        <nav className="editions mobile-editions" aria-label="简报类型">
          {Object.entries(kindNames).map(([key, label]) => (
            <Link key={key} href={`/?kind=${key}`} aria-current={kind === key ? 'page' : undefined}>
              {label}
            </Link>
          ))}
        </nav>
        {children}
      </main>
    </div>
  );
}
