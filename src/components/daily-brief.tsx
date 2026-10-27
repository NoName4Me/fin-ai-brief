import type { BriefContent } from '../server/types.ts';
import { dateLabel } from '../server/periods.ts';
import { weekday, sectionGroups, sectionAnchor } from '../server/brief-presentation.ts';
import { PrintButton } from './navigation.tsx';
import { PublicationFooter } from './publication-footer.tsx';
import { SourceRow, Summary } from './brief-story.tsx';
import { Rating } from './rating.tsx';
import { sourceNames } from '../server/source-presentation.ts';

export function DailyBrief({
  content,
  date,
  issueNumber,
}: {
  content: BriefContent;
  date: string;
  issueNumber?: number | null;
}) {
  const groups = sectionGroups(content.items, []);
  const sources = [
    ...content.items.flatMap((i) => i.sources),
    ...(content.rotations ?? []).flatMap((r) => r.sources),
  ];
  return (
    <div className="workspace daily-workspace domain-ai">
      <div className="content-column">
        <article className="paper report-view">
          <header className="report-heading edition-heading">
            <div className="edition-subject">
              <h1>{content.title}</h1>
            </div>
            <div className="edition-meta" aria-label="日报出刊信息">
              <time className="edition-calendar" dateTime={date}>
                <span className="edition-calendar-month">
                  {date.slice(0, 4)}年{Number(date.slice(5, 7))}月
                </span>
                <span className="edition-calendar-day">{date.slice(-2)}</span>
                <span className="edition-calendar-weekday">
                  {weekday(date).replace('周', '星期')}
                </span>
              </time>
              <time className="edition-calendar-compact" dateTime={date}>
                {dateLabel(date)}　{weekday(date).replace('周', '星期')}
              </time>
              <p className="edition-number">
                {issueNumber ? `第${String(issueNumber).padStart(3, '0')}期` : '待编期'}
              </p>
            </div>
          </header>
          <div className="edition-tools">
            <PrintButton />
          </div>
          {!!content.highlights?.length && (
            <section className="edition-overview daily-highlights" id="highlights">
              <h2>今日要览</h2>
              <ol>
                {content.highlights.map((h) => (
                  <li key={h.eventId}>
                    <a href={`#event-${h.eventId}`}>{h.text}</a>
                    <Rating value={h.rating} />
                  </li>
                ))}
              </ol>
            </section>
          )}
          {content.note && <p className="empty-state">{content.note}</p>}
          {groups.map((group) => (
            <section className="chapter" key={group.name} id={sectionAnchor('ai', group.name)}>
              <header className="chapter-heading">
                <h2>{group.name}</h2>
                <span>{group.items.length}条</span>
              </header>
              <div className="section-stories">
                {group.items.map((item, index) => (
                  <article
                    className={index === 0 ? 'lead-story' : 'story-item chapter-brief'}
                    key={item.eventId}
                    id={`event-${item.eventId}`}
                  >
                    <div className="story-copy">
                      <div className="daily-story-heading">
                        <h3>{item.title}</h3>
                        {item.rating !== undefined && <Rating value={item.rating} />}
                      </div>
                      <p>
                        <Summary item={item} />
                      </p>
                      <SourceRow item={item} />
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
          {content.rotations?.map((r) => (
            <section className="chapter daily-rotation" key={r.name} id={`rotation-${r.name}`}>
              <header className="chapter-heading">
                <h2>{r.name}</h2>
              </header>
              <p className="rotation-copy">{r.text}</p>
              <div className="source-row">
                {r.sources.map((s) => (
                  <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer">
                    {s.name}
                  </a>
                ))}
              </div>
            </section>
          ))}
          <PublicationFooter kind="daily" content={content} />
        </article>
      </div>
      <aside className="context" aria-label="日报目录与来源">
        <div className="context-block">
          <h2 className="context-head">
            目录<small>{content.items.length}条资讯</small>
          </h2>
          <ul className="outline-list">
            {content.highlights?.length ? (
              <li>
                <a href="#highlights">今日要览</a>
              </li>
            ) : null}
            {groups.map((g) => (
              <li key={g.name}>
                <a href={`#${sectionAnchor('ai', g.name)}`}>{g.name}</a>
              </li>
            ))}
            {content.rotations?.map((r) => (
              <li key={r.name}>
                <a href={`#rotation-${r.name}`}>{r.name}</a>
              </li>
            ))}
          </ul>
        </div>
        <details className="context-block daily-source-list">
          <summary className="context-head">
            <h2>资料来源</h2>
          </summary>
          <ul className="source-files">
            {sourceNames(sources).map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </details>
      </aside>
    </div>
  );
}
