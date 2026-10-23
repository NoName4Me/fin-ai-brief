import Link from 'next/link';
import { ReaderShell } from '../../components/reader-shell.tsx';
import { listPublished } from '../../server/publication.ts';
import { kindNames, kindSchema, type Kind } from '../../server/types.ts';
import { dateLabel } from '../../server/periods.ts';
export const metadata = { title: '历史简报' };
export default async function Archive({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const q = await searchParams;
  const kind = kindSchema.safeParse(q.kind);
  const rows = await listPublished(kind.success ? kind.data : undefined);
  const filtered = rows.filter(
    (r) => (!q.from || r.periodDate >= q.from) && (!q.to || r.periodDate <= q.to),
  );
  return (
    <ReaderShell>
      <section className="paper">
        <div className="view-header">
          <div>
            <h1>历史简报</h1>
            <p>按期查阅正式发布的金融与AI简报。</p>
          </div>
          <span className="eyeline">共{filtered.length}期</span>
        </div>
        <form className="archive-tools">
          <label>
            类型
            <select name="kind" defaultValue={q.kind ?? ''}>
              <option value="">全部</option>
              {Object.entries(kindNames).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            从<input type="date" name="from" defaultValue={q.from} />
          </label>
          <label>
            至<input type="date" name="to" defaultValue={q.to} />
          </label>
          <button className="solid-button">查询</button>
        </form>
        {filtered.map((row) => (
          <Link href={`/briefs/${row.id}`} className="archive-entry" key={row.id}>
            <div className="archive-number">
              {row.periodDate.slice(-2)}
              <small>日</small>
            </div>
            <div className="archive-copy">
              <h2>{row.content?.title}</h2>
              <p>
                {dateLabel(row.periodDate)}　{row.content?.items.length}条要情
              </p>
            </div>
            <span className="archive-kind">{kindNames[row.kind as Kind]}</span>
          </Link>
        ))}
        {!filtered.length && <p className="empty-state">没有符合条件的正式简报。</p>}
      </section>
    </ReaderShell>
  );
}
