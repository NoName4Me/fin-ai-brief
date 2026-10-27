import type { BriefContent, Kind } from '../server/types.ts';
import { kindNames } from '../server/types.ts';
import { dateLabel } from '../server/periods.ts';
import { PublicationFooter } from './publication-footer.tsx';
import { sectionAnchor, sectionGroups, weekday } from '../server/brief-presentation.ts';
import { BriefContext } from './brief-context.tsx';
import { SourceRow, Summary } from './brief-story.tsx';
import { PrintButton } from './navigation.tsx';
import { PeriodBrief } from './period-brief.tsx';
import { DailyBrief } from './daily-brief.tsx';
type Industry = { id: string; name: string; description: string; sections: string[] };
function Story({
  item,
  lead = false,
  brief = false,
}: {
  item: BriefContent['items'][number];
  lead?: boolean;
  brief?: boolean;
}) {
  return (
    <article
      id={`event-${item.eventId}`}
      className={lead ? 'lead-story' : `story-item ${brief ? 'chapter-brief' : ''}`}
    >
      <div className={lead ? undefined : 'story-copy'}>
        <h4>{item.title}</h4>
        <p>
          <Summary item={item} />
        </p>
        <SourceRow item={item} />
      </div>
    </article>
  );
}
export function Brief({
  content,
  kind,
  date,
  industries,
  issueNumber,
}: {
  content: BriefContent;
  kind: Kind;
  date: string;
  industries: Industry[];
  issueNumber?: number | null;
}) {
  if (content.format === 'ai-daily-v1')
    return <DailyBrief content={content} date={date} issueNumber={issueNumber} />;
  if (kind !== 'daily') {
    return (
      <PeriodBrief
        content={content}
        kind={kind}
        date={date}
        industries={industries}
        issueNumber={issueNumber}
      />
    );
  }
  return (
    <div className="workspace">
      <div className="content-column">
        <section className="paper report-view">
          <header className="report-heading edition-heading">
            <div className="edition-subject">
              <h1>{content.title}</h1>
            </div>
            <div className="edition-meta" aria-label={`${kindNames[kind]}出刊信息`}>
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
          <section className="edition-overview">
            <div className="overview-domains">
              {industries
                .filter((i) => content.overview[i.id])
                .map((i) => (
                  <section
                    className={`overview-domain domain-${i.id}`}
                    key={i.id}
                    aria-label={`${i.name}总览`}
                  >
                    <h3>{i.name}</h3>
                    <p>{content.overview[i.id]}</p>
                  </section>
                ))}
            </div>
          </section>
          {industries.map((industry) => {
            const items = content.items.filter((i) => i.industryId === industry.id);
            if (!items.length) return null;
            return (
              <section
                className={`chapter domain-${industry.id}`}
                id={`chapter-${industry.id}`}
                key={industry.id}
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
                    <div className="section-stories">
                      <div className="chapter-lead">
                        <Story item={group.items[0]} lead />
                      </div>
                      {group.items.length > 1 && (
                        <div className="story-grid chapter-pair">
                          {group.items.slice(1, 3).map((item) => (
                            <Story item={item} key={item.eventId} />
                          ))}
                        </div>
                      )}
                      {group.items.slice(3).map((item) => (
                        <Story item={item} brief key={item.eventId} />
                      ))}
                    </div>
                  </section>
                ))}
              </section>
            );
          })}
          <PublicationFooter kind={kind} content={content} />
        </section>
      </div>
      <BriefContext content={content} industries={industries} />
    </div>
  );
}
