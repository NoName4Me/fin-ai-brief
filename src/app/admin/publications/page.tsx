import { SourceManagementDialog } from '../../../components/source-management-dialog.tsx';
import { PublicationSettingsForm } from '../../../components/settings-forms.tsx';
import { requireAdmin } from '../../../server/auth.ts';
import Link from 'next/link';
import { desc } from 'drizzle-orm';
import { db } from '../../../server/db.ts';
import { briefs } from '../../../server/schema.ts';
import { getSettings } from '../../../server/settings.ts';
import { localDate, dateLabel } from '../../../server/periods.ts';
import { kindNames, type Kind } from '../../../server/types.ts';
import { generateAction, publishAction, backfillAction } from '../../actions.ts';
import { Notice, type Query } from '../../../components/notice.tsx';
export default async function Publications({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const query = await searchParams;
  const [rows, config] = await Promise.all([
    db.select().from(briefs).orderBy(desc(briefs.periodDate)).limit(50),
    getSettings(),
  ]);
  return (
    <>
      <Notice query={await searchParams} />
      <div className="admin-page-actions">
        <Link className="solid-button" href="/admin/publications?configure=backfill" scroll={false}>
          手动补刊
        </Link>
        <Link
          className="outline-button"
          href="/admin/publications?configure=publication"
          scroll={false}
        >
          出刊设置
        </Link>
      </div>
      {query.configure === 'publication' && (
        <SourceManagementDialog title="出刊设置" closeHref="/admin/publications">
          <PublicationSettingsForm config={config} />
        </SourceManagementDialog>
      )}
      {query.configure === 'backfill' && (
        <SourceManagementDialog title="手动补刊" closeHref="/admin/publications">
          <form action={backfillAction} className="stack-form settings-dialog-form">
            <input type="hidden" name="kind" value="daily" />
            <input type="hidden" name="confirmed" value="true" />
            <label>
              起始日期
              <input
                type="date"
                name="from"
                min={config.startDate}
                max={localDate()}
                defaultValue={localDate()}
                required
              />
            </label>
            <label>
              结束日期
              <input
                type="date"
                name="to"
                min={config.startDate}
                max={localDate()}
                defaultValue={localDate()}
                required
              />
            </label>
            <button className="solid-button">补刊</button>
          </form>
        </SourceManagementDialog>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日期 / 类型</th>
              <th>简报</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {dateLabel(row.periodDate)}
                  <br />
                  <span className="muted">{kindNames[row.kind as Kind]}</span>
                </td>
                <td>{(row.draft ?? row.published)?.title}</td>
                <td>
                  {row.draft ? '待审核' : row.published ? '已发布' : '待生成'}
                  {row.draft && row.published && <small>原正式版仍可阅读</small>}
                </td>
                <td>
                  <div className="row-actions">
                    {row.draft && (
                      <>
                        <Link href={`/admin/briefs/${row.id}`}>阅读待审稿</Link>
                        <form action={publishAction}>
                          <input type="hidden" name="id" value={row.id} />
                          <button className="solid-button">审核并发布</button>
                        </form>
                      </>
                    )}
                    {row.published && <Link href={`/briefs/${row.id}`}>正式版</Link>}
                    {row.kind === 'daily' && (
                      <form action={generateAction}>
                        <input type="hidden" name="direct" value="true" />
                        <input type="hidden" name="kind" value={row.kind} />
                        <input type="hidden" name="date" value={row.periodDate} />
                        <label className="check">
                          <input type="checkbox" name="reprocess" />
                          先重新处理资讯
                        </label>
                        <button className="quiet-button">重新生成</button>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <p className="empty-state">尚无简报。先配置栏目和信源，采集或导入资讯，再生成。</p>
      )}
    </>
  );
}
