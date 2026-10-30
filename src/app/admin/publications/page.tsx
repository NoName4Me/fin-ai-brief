import { cleanBriefTitle } from '../../../server/brief-title.ts';
import { SourceManagementDialog } from '../../../components/source-management-dialog.tsx';
import { PublicationSettingsForm } from '../../../components/settings-forms.tsx';
import { requireAdmin } from '../../../server/auth.ts';
import Link from 'next/link';
import { desc } from 'drizzle-orm';
import { db } from '../../../server/db.ts';
import { briefs } from '../../../server/schema.ts';
import { getSettings } from '../../../server/settings.ts';
import { localDate, dateLabel } from '../../../server/periods.ts';
import { generateAction, publishAction, backfillAction } from '../../actions.ts';
import { Notice, type Query } from '../../../components/notice.tsx';
export default async function Publications({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const query = await searchParams;
  const [rows, config] = await Promise.all([
    db.select().from(briefs).orderBy(desc(briefs.periodDate)).limit(50),
    getSettings(),
  ]);
  const regenerating =
    query.configure === 'regenerate' && typeof query.issue === 'string'
      ? rows.find((row) => row.id === query.issue && row.kind === 'daily')
      : undefined;
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
      {regenerating && (
        <SourceManagementDialog title="重新生成" closeHref="/admin/publications">
          <form action={generateAction} className="stack-form settings-dialog-form">
            <p>{dateLabel(regenerating.periodDate)}</p>
            <input type="hidden" name="direct" value="true" />
            <input type="hidden" name="kind" value={regenerating.kind} />
            <input type="hidden" name="date" value={regenerating.periodDate} />
            <label className="check">
              <input type="checkbox" name="reprocess" />
              先重新处理资讯
            </label>
            <button className="solid-button">确认重新生成</button>
          </form>
        </SourceManagementDialog>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>出刊日期/期号</th>
              <th>标题</th>
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
                  <span className="muted">
                    {row.issueNumber ? `第${String(row.issueNumber).padStart(3, '0')}期` : '待编期'}
                  </span>
                </td>
                <td>
                  <Link href={row.published ? `/briefs/${row.id}` : `/admin/briefs/${row.id}`}>
                    {cleanBriefTitle((row.published ?? row.draft)?.title ?? '')}
                  </Link>
                </td>
                <td>
                  {row.draft ? '待审核' : row.published ? '已发布' : '待生成'}
                  {row.draft && row.published && <small>原正式版仍可阅读</small>}
                </td>
                <td>
                  <div className="row-actions">
                    {row.published && <Link href={`/admin/briefs/${row.id}`}>编辑</Link>}
                    {row.draft && (
                      <>
                        {!row.published && <Link href={`/admin/briefs/${row.id}`}>编辑</Link>}
                        <form action={publishAction}>
                          <input type="hidden" name="id" value={row.id} />
                          <button className="solid-button">审核并发布</button>
                        </form>
                      </>
                    )}
                    {row.kind === 'daily' && (
                      <Link
                        href={`/admin/publications?configure=regenerate&issue=${row.id}`}
                        scroll={false}
                      >
                        重新生成
                      </Link>
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
