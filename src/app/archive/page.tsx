import Link from 'next/link';
import { listPublished } from '../../server/publication.ts';
import { dateLabel } from '../../server/periods.ts';
export const metadata = { title: '全部日报' };
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
        <form className="archive-tools" aria-label="全部日报筛选">
          <div className="archive-date-range">
            <input type="date" name="from" aria-label="起始日期" defaultValue={q.from} />
            <span aria-hidden="true">-</span>
            <input type="date" name="to" aria-label="结束日期" defaultValue={q.to} />
          </div>
          <button className="solid-button">查询</button>
        </form>
        {filtered.map((row) => (
          <Link href={`/briefs/${row.id}`} className="archive-entry" key={row.id}>
            <div className="archive-copy">
              <h2>{row.content?.title}</h2>
              <p>
                {dateLabel(row.periodDate)}
                {row.issueNumber ? `　第${String(row.issueNumber).padStart(3, '0')}期` : ''}　
                {row.content?.items.length}条要情
              </p>
            </div>
          </Link>
        ))}
        {!filtered.length && <p className="empty-state">没有符合条件的正式简报。</p>}
      </section>
    </main>
  );
}
