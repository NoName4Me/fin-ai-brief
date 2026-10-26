import type { BriefContent } from '../server/types.ts';
import { dateLabel, timeLabel } from '../server/periods.ts';
import { orderedSources, sourceName } from '../server/source-presentation.ts';
import { SourceDialog } from './source-dialog.tsx';
export function SourceRow({ item }: { item: BriefContent['items'][number] }) {
  const sources = orderedSources(item.sources);
  return (
    <div className="source-row">
      <span>
        {sourceName(sources[0].name)}
        {sources.length > 1 ? ' 等' : ''}
      </span>
      <span className="sep">/</span>
      <SourceDialog title={item.title}>
        <div className="source-detail-content">
          {sources.map((s) => (
            <p key={s.url}>
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.title}
              </a>
              <br />
              <span>
                {sourceName(s.name)}　{dateLabel(s.publishedAt)}
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
export function Summary({ item }: { item: BriefContent['items'][number] }) {
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
