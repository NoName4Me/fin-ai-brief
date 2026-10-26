import { dateLabel, timeLabel } from '../server/periods.ts';
import { kindNames, type Kind, type BriefContent } from '../server/types.ts';
export function PublicationFooter({
  kind,
  content,
}: {
  kind: Kind;
  content: Pick<BriefContent, 'rangeStart' | 'rangeEnd'>;
}) {
  return (
    <>
      <footer className="publication-footer">
        <strong className="publication-name">Fin&amp;AI简报·{kindNames[kind]}</strong>
        <span className="publication-finish">本期完</span>
        <span className="publication-colophon">
          <strong>数智化转型办公室·智创组</strong>　<span>编制</span>
        </span>
      </footer>
      <p className="publication-range">
        统计范围：{dateLabel(content.rangeStart)} {timeLabel(content.rangeStart)}—
        {dateLabel(content.rangeEnd)} {timeLabel(content.rangeEnd)}（北京时间）。
        正文为来源摘要，原始资料与事实边界以所附来源为准。
      </p>
    </>
  );
}
