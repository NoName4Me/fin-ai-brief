import Link from 'next/link';
import { listPublished } from '../../server/publication.ts';
import { kindNames, type Kind } from '../../server/types.ts';
import { dateLabel } from '../../server/periods.ts';
import { editionCalendar } from '../../server/brief-presentation.ts';
export const metadata = { title: '历史日报' };
export default async function Archive({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const q = await searchParams;
  const rows = await listPublished('daily');
  const filtered = rows.filter(
    (r) => (!q.from || r.periodDate >= q.from) && (!q.to || r.periodDate <= q.to),
  );
  return (
    <main className="news-main archive-main">
      <section className="paper">
        <div className="view-header">
          <div>
            <h1>历史日报</h1>
            <p>按日期查阅已发布的数智参阅。</p>
          </div>
          <span className="eyeline">共{filtered.length}期</span>
        </div>
        <form className="archive-tools">
          <label>
            从<input type="date" name="from" defaultValue={q.from} />
          </label>
          <label>
            至<input type="date" name="to" defaultValue={q.to} />
          </label>
          <button className="solid-button">查询</button>
        </form>
        {filtered.map((row) => {
          const calendar = editionCalendar(row.kind as Kind, row.periodDate, row.content!);
          return (
            <Link href={`/briefs/${row.id}`} className="archive-entry" key={row.id}>
              <div className="archive-number">
                <small>{calendar.top}</small>
                <strong>{calendar.number}</strong>
                {row.kind === 'weekly' && <small>{calendar.detail}</small>}
              </div>
              <div className="archive-copy">
                <h2>{row.content?.title}</h2>
                <p>
                  {dateLabel(row.periodDate)}
                  {row.issueNumber ? `　第${String(row.issueNumber).padStart(3, '0')}期` : ''}　
                  {row.content?.items.length}条要情
                </p>
              </div>
              <span className="archive-kind">{kindNames[row.kind as Kind]}</span>
            </Link>
          );
        })}
        {!filtered.length && <p className="empty-state">没有符合条件的正式简报。</p>}
      </section>
    </main>
  );
}
