import type { BriefContent } from '../server/types.ts';
import { localDate } from '../server/periods.ts';
import { PublicationFooter } from './publication-footer.tsx';
import { PrintButton } from './navigation.tsx';
import { BriefContext } from './brief-context.tsx';
import { WeeklyProgress } from './weekly-progress.tsx';
import { SourceRow, Summary } from './brief-story.tsx';
import { editionCalendar, sectionAnchor, sectionGroups } from '../server/brief-presentation.ts';

type Industry = { id: string; name: string; sections: string[] };
type PeriodKind = 'weekly' | 'monthly';
export function PeriodBrief({
  content,
  kind,
  date,
  industries,
  issueNumber,
}: {
  content: BriefContent;
  kind: PeriodKind;
  date: string;
  industries: Industry[];
  issueNumber?: number | null;
}) {
  const monthly = kind === 'monthly';
  const review = kind === 'weekly' && content.format === 'weekly-review-v1';
  const calendar = editionCalendar(kind, date, content);
  const domains = industries.filter((industry) =>
    content.items.some((item) => item.industryId === industry.id),
  );
  const timeline = content.items
    .map((item) => ({
      item,
      day: [...item.sources]
        .map((source) =>
          source.publishedAt.length === 10
            ? source.publishedAt
            : localDate(new Date(source.publishedAt)),
        )
        .sort()[0],
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
  return (
    <div className={`workspace period-workspace period-${kind}${review ? ' weekly-review' : ''}`}>
      <div className="content-column">
        <article className="paper period-paper">
          <header className="period-masthead report-heading edition-heading">
            <h1 id="period-title" className="period-title">
              {content.title}
            </h1>
            <div
              className="period-date-mark"
              aria-label={monthly ? '月报出刊信息' : '周报出刊信息'}
            >
              <span>{calendar.top}</span>
              <strong className="edition-calendar-day">{calendar.number}</strong>
              {calendar.detail && <span className="period-date-range">{calendar.detail}</span>}
              <p className="period-issue">
                {issueNumber ? `第${String(issueNumber).padStart(3, '0')}期` : '待编期'}
              </p>
            </div>
          </header>
          <div className="edition-tools">
            <PrintButton />
          </div>
          <section className="period-opening edition-overview" aria-label="本期行业概览">
            <div className="period-summary">
              {domains
                .filter((industry) => content.overview[industry.id])
                .map((industry) => (
                  <div key={industry.id}>
                    <h3>{industry.name}</h3>
                    <p>{content.overview[industry.id]}</p>
                  </div>
                ))}
            </div>
          </section>
          {domains.map((industry) => {
            const items = content.items.filter((item) => item.industryId === industry.id);
            return (
              <section
                className={`chapter period-domain domain-${industry.id}`}
                key={industry.id}
                id={`chapter-${industry.id}`}
              >
                <header className="chapter-heading">
                  <div>
                    <h2>{industry.name}要情</h2>
                    <p>{industry.sections.join(' / ')}</p>
                  </div>
                  <span>本版{items.length}条</span>
                </header>
                {sectionGroups(items, industry.sections).map((group) => (
                  <section className="brief-section" key={group.name}>
                    <h3
                      className="brief-section-heading"
                      id={sectionAnchor(industry.id, group.name)}
                    >
                      {group.name}
                    </h3>
                    <div className="period-stories">
                      {group.items.map((item, index) => (
                        <article
                          className={`period-story ${index === 0 ? 'period-story-lead' : ''}`}
                          id={`event-${item.eventId}`}
                          key={item.eventId}
                        >
                          <div className="period-story-meta">
                            <span>
                              {(review
                                ? item.sources.find(
                                    (source) =>
                                      new Date(source.publishedAt) >= new Date(content.rangeStart),
                                  )
                                : item.sources[0]
                              )?.publishedAt
                                .slice(5, 10)
                                .replace('-', '.')}
                              {review ? ' 报道' : ''}
                            </span>
                          </div>
                          <h4>{item.title}</h4>
                          <p>
                            <Summary item={item} />
                          </p>
                          {review && <WeeklyProgress item={item} />}
                          <SourceRow item={item} />
                        </article>
                      ))}
                    </div>
                  </section>
                ))}
              </section>
            );
          })}
          {!review && (
            <section className="period-chronology" id="period-timeline">
              <div className="period-section-title">
                <h2>{monthly ? '月内时间轴' : '一周进程'}</h2>
              </div>
              <ol>
                {timeline.map(({ item, day }) => (
                  <li key={item.eventId}>
                    <time dateTime={day}>{day.slice(5).replace('-', '.')}</time>
                    <a href={`#event-${item.eventId}`}>{item.title}</a>
                  </li>
                ))}
              </ol>
            </section>
          )}
          <PublicationFooter />
        </article>
      </div>
      <BriefContext content={content} industries={industries} />
    </div>
  );
}
