import type { BriefContent } from '../server/types.ts';
import { sectionLinks } from '../server/brief-presentation.ts';
import { sourceNames } from '../server/source-presentation.ts';

type Industry = { id: string; name: string; sections: string[] };
export function BriefContext({
  content,
  industries,
}: {
  content: BriefContent;
  industries: Industry[];
}) {
  return (
    <aside className="context" aria-label="简报目录与来源">
      <div className="context-block">
        <h2 className="context-head">
          目录<small>{content.items.length}条要情</small>
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
          {sourceNames(content.items.flatMap((item) => item.sources)).map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
