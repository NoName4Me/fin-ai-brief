import type { BriefContent, Kind } from '../server/types.ts';
import { kindNames } from '../server/types.ts';
import { dateLabel, timeLabel } from '../server/periods.ts';
import { sectionAnchor, sectionLinks, weekday } from '../server/brief-presentation.ts';
import { SourceDialog } from './source-dialog.tsx';
import { PrintButton } from './navigation.tsx';
type Industry = { id: string; name: string; description: string; sections: string[] };
function SourceRow({ item }: { item: BriefContent['items'][number] }) {
  return (
    <div className="source-row">
      <span>{[...new Set(item.sources.map((s) => s.name))].join(' / ')}</span>
      <span className="sep">/</span>
      <SourceDialog title={item.title}>
        <div className="source-detail-content">
          {item.sources.map((s) => (
            <p key={s.url}>
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.title}
              </a>
              <br />
              <span>
                {s.name}　{dateLabel(s.publishedAt)}
                {s.publishedAt.length > 10 ? ` ${timeLabel(s.publishedAt)}` : '（时刻未披露）'}
              </span>
              {s.timeNote && (
                <>
                  <br />
                  <span>{s.timeNote}</span>
                </>
              )}
              {s.detail && (
                <>
                  <br />
                  <span>{s.detail}</span>
                </>
              )}
              {s.announcementUrl && (
                <>
                  <br />
                  <a href={s.announcementUrl} target="_blank" rel="noopener noreferrer">
                    公告原帖
                  </a>
                </>
              )}
              {s.timingIndexUrl && (
                <>
                  　
                  <a href={s.timingIndexUrl} target="_blank" rel="noopener noreferrer">
                    时间索引
                  </a>
                </>
              )}
            </p>
          ))}
        </div>
      </SourceDialog>
    </div>
  );
}
function Summary({ item }: { item: BriefContent['items'][number] }) {
  const phrases = item.emphasis?.filter((phrase) => item.summary.includes(phrase)) ?? [];
  if (!phrases.length) return <>{item.summary}</>;
  const pattern = new RegExp(
    `(${phrases.map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'g',
  );
  return (
    <>
      {item.summary
        .split(pattern)
        .map((part, index) =>
          phrases.includes(part) ? <strong key={index}>{part}</strong> : part,
        )}
    </>
  );
}
function Story({
  item,
  lead = false,
  brief = false,
  anchor,
}: {
  item: BriefContent['items'][number];
  lead?: boolean;
  brief?: boolean;
  anchor?: string;
}) {
  return (
    <article
      id={`event-${item.eventId}`}
      className={lead ? 'lead-story' : `story-item ${brief ? 'chapter-brief' : ''}`}
    >
      {lead ? (
        <div className="lead-kicker" id={anchor}>
          <span>重点关注</span>
          <span>{item.section}</span>
        </div>
      ) : (
        <div className="category-label" id={anchor}>
          {item.section}
        </div>
      )}
      <div className={lead ? undefined : 'story-copy'}>
        <h3>{item.title}</h3>
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
            <h2>总览</h2>
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
                <div className="chapter-lead">
                  <Story
                    item={items[0]}
                    lead
                    anchor={sectionAnchor(industry.id, items[0].section)}
                  />
                </div>
                {items.length > 1 && (
                  <div className="story-grid chapter-pair">
                    {items.slice(1, 3).map((item) => (
                      <Story
                        item={item}
                        key={item.eventId}
                        anchor={
                          items.find((first) => first.section === item.section)?.eventId ===
                          item.eventId
                            ? sectionAnchor(industry.id, item.section)
                            : undefined
                        }
                      />
                    ))}
                  </div>
                )}
                {items.slice(3).map((item) => (
                  <Story
                    item={item}
                    brief
                    key={item.eventId}
                    anchor={
                      items.find((first) => first.section === item.section)?.eventId ===
                      item.eventId
                        ? sectionAnchor(industry.id, item.section)
                        : undefined
                    }
                  />
                ))}
              </section>
            );
          })}
          <div className="paper-end">
            <span>Fin&AI简报 / 金融与AI资讯简报</span>
            <span>本期完</span>
          </div>
          <p className="report-colophon">
            <strong>数智化转型办公室·智创组</strong>　编制
          </p>
          <p className="test-note">
            {content.note && (
              <>
                {content.note}
                <br />
              </>
            )}
            统计范围：{dateLabel(content.rangeStart)} {timeLabel(content.rangeStart)}—
            {dateLabel(content.rangeEnd)} {timeLabel(content.rangeEnd)}
            （北京时间）。正文为来源摘要，原始资料与事实边界以所附来源为准。
          </p>
        </section>
      </div>
      <aside className="context">
        <div className="context-block">
          <h2 className="context-head">
            本期目录<small>{content.items.length}条要情</small>
          </h2>
          {industries.map((i) => {
            const items = content.items.filter((item) => item.industryId === i.id);
            return items.length ? (
              <div className={`toc-domain domain-${i.id}`} key={i.id}>
                <a className="toc-domain-title" href={`#chapter-${i.id}`}>
                  {i.name}要情
                </a>
                <ul className="outline-list">
                  {sectionLinks(content, i).map((section) => (
                    <li key={section.name}>
                      <a href={`#${section.anchor}`}>{section.name}</a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null;
          })}
        </div>
        <div className="context-block">
          <h2 className="context-head">资料来源</h2>
          <ul className="source-files">
            {[...new Set(content.items.flatMap((i) => i.sources.map((s) => s.name)))].map(
              (name) => (
                <li key={name}>{name}</li>
              ),
            )}
          </ul>
        </div>
        <div className="source-note">
          <strong>阅读说明</strong>
          关注事实与后续进展，不将计划当作已实现结果。每条资讯保留原文链接。
        </div>
      </aside>
    </div>
  );
}
