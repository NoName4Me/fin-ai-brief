import { ReaderOutline } from './reader-outline.tsx';
import type { BriefContent } from '../server/types.ts';
import { dateLabel } from '../server/periods.ts';
import { weekday, dailySections, sectionAnchor } from '../server/brief-presentation.ts';
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
  const sections = dailySections(content);
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
              <time className="edition-calendar-compact" dateTime={date}>
                {dateLabel(date)}　{weekday(date).replace('周', '星期')}
              </time>
              <p className="edition-number">
                {`《数智阅参》${issueNumber ? `第${String(issueNumber).padStart(3, '0')}期` : '待编期'}`}
              </p>
              <span className="edition-host">主办：数智化转型办公室 AI工作组</span>
              <PrintButton />
            </div>
          </header>
          {!!content.highlights?.length && (
            <section className="edition-overview daily-highlights" id="highlights">
              <h2>{content.highlightsTitle ?? '今日要览'}</h2>
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
          {sections.map((group) =>
            group.kind === 'fixed' ? (
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
            ) : (
              <section
                className="chapter daily-rotation"
                key={group.name}
                id={`rotation-${group.name}`}
              >
                <header className="chapter-heading">
                  <h2>{group.displayName ?? group.name}</h2>
                </header>
                <p className="rotation-copy">{group.text}</p>
                <SourceRow
                  item={{ title: group.displayName ?? group.name, sources: group.sources }}
                />
              </section>
            ),
          )}
          <PublicationFooter />
        </article>
      </div>
      <aside className="context" aria-label="日报目录与来源">
        <div className="context-block">
          <h2 className="context-head">
            目录<small>{content.items.length}条资讯</small>
          </h2>
          <ReaderOutline
            items={[
              ...(content.highlights?.length
                ? [{ id: 'highlights', label: content.highlightsTitle ?? '今日要览' }]
                : []),
              ...sections.map((group) => ({
                id:
                  group.kind === 'fixed'
                    ? sectionAnchor('ai', group.name)
                    : `rotation-${group.name}`,
                label: group.kind === 'rotation' ? (group.displayName ?? group.name) : group.name,
              })),
            ]}
          />
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
