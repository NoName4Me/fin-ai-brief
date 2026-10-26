import type { BriefContent } from '../server/types.ts';
import { dateLabel } from '../server/periods.ts';
import { orderedSources, sourceName } from '../server/source-presentation.ts';
import { SourceDialog } from './source-dialog.tsx';

type Item = BriefContent['items'][number];
export function WeeklyProgress({ item }: { item: Item }) {
  if (!item.progress?.length) return null;
  return (
    <section className="weekly-progress" aria-label={`${item.title}本周进展`}>
      <h5>本周进展</h5>
      <ol>
        {item.progress.map((node, index) => (
          <li key={`${node.date}-${index}`}>
            <div className="weekly-progress-date">
              <time dateTime={node.date}>{node.date.slice(5).replace('-', '.')}</time>
              {node.endDate && <span>—{node.endDate.slice(5).replace('-', '.')}</span>}
              <span>报道</span>
            </div>
            <div className="weekly-progress-copy">
              <p>{node.text}</p>
              <SourceDialog
                title={`${dateLabel(node.date)}${node.endDate ? `—${dateLabel(node.endDate)}` : ''} · ${node.text}`}
                label="依据"
              >
                <div className="source-detail-content progress-evidence">
                  {orderedSources(
                    item.sources.filter((source) => node.sourceUrls.includes(source.url)),
                  ).map((source) => (
                    <section key={source.url}>
                      <a href={source.url} target="_blank" rel="noopener noreferrer">
                        {source.title}
                      </a>
                      <p>
                        {sourceName(source.name)}　{dateLabel(source.publishedAt)}
                      </p>
                      {node.evidence
                        .filter((e) => e.sourceUrl === source.url)
                        .map((e, i) => (
                          <blockquote key={i}>{e.excerpt}</blockquote>
                        ))}
                    </section>
                  ))}
                </div>
              </SourceDialog>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
