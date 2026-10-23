import { NewsFeed } from '../../components/news-feed.tsx';
import { newsSnapshot, publicIndustries } from '../../server/publication.ts';
export const metadata = { title: '7×24资讯' };
export default async function News({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const q = await searchParams;
  const [rows, topics] = await Promise.all([
    newsSnapshot(q.industry, q.q?.slice(0, 100)),
    publicIndustries(),
  ]);
  return (
    <main className="news-main">
      <section className="paper">
        <div className="view-header">
          <div>
            <h1>7×24资讯</h1>
            <p>关注金融与AI的重要事实及后续进展。</p>
          </div>
        </div>
        <NewsFeed
          key={`${q.industry ?? ''}:${q.q ?? ''}`}
          initial={rows.items}
          cursor={rows.cursor}
          industry={q.industry ?? ''}
          q={(q.q ?? '').slice(0, 100)}
          topics={topics}
          searchTools={
            <form className="archive-tools">
              <label>
                行业
                <select name="industry" defaultValue={q.industry ?? ''}>
                  <option value="">全部</option>
                  {topics.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                搜索
                <input type="search" name="q" defaultValue={q.q} maxLength={100} />
              </label>
              <button className="solid-button">查询</button>
            </form>
          }
        />
      </section>
    </main>
  );
}
