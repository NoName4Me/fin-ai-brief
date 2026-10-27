import { requireAdmin } from '../../server/auth.ts';
import Link from 'next/link';
import { desc } from 'drizzle-orm';
import { db } from '../../server/db.ts';
import { briefs } from '../../server/schema.ts';
import { getSettings } from '../../server/settings.ts';
import { localDate, dateLabel } from '../../server/periods.ts';
import { kindNames, type Kind } from '../../server/types.ts';
import { generateAction, publishAction, previewGenerateAction } from '../actions.ts';
import { generationStatus } from '../../server/generation-requests.ts';
import { previewBrief } from '../../server/briefs.ts';
import { kindSchema } from '../../server/types.ts';
import { Notice, type Query } from '../../components/notice.tsx';
export default async function Dashboard({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const query = await searchParams;
  let preview: Awaited<ReturnType<typeof previewBrief>> | undefined,
    previewError = '';
  let pendingStatus: Awaited<ReturnType<typeof generationStatus>> | undefined;
  const previewKind = kindSchema.safeParse(query.kind);
  if (query.preview === '1' && previewKind.success && typeof query.date === 'string')
    try {
      pendingStatus = await generationStatus(previewKind.data, query.date);
      if (!pendingStatus.pending && query.reprocess !== '1')
        preview = await previewBrief(previewKind.data, query.date);
    } catch (e) {
      previewError = e instanceof Error ? e.message : '预览失败';
    }
  const [rows, config] = await Promise.all([
    db.select().from(briefs).orderBy(desc(briefs.periodDate)).limit(50),
    getSettings(),
  ]);
  return (
    <>
      <Notice query={await searchParams} />
      <form action={previewGenerateAction} className="inline-form">
        <label>
          类型
          <select name="kind">
            {Object.entries({ daily: '日报' }).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          出刊日期
          <input type="date" name="date" defaultValue={localDate()} required />
        </label>
        <button className="solid-button">生成前检查</button>
      </form>
      <p className="form-hint">
        每天北京时间08:00截稿，覆盖前一日08:00至当日08:00。生成完成后按发布设置发布。
      </p>
      <p>
        <Link href="/admin/articles?type=generate">出刊任务与记录</Link>
      </p>
      {previewError && <p className="notice error">{previewError}</p>}
      {query.reprocess === '1' && previewKind.success && (
        <section className="admin-section">
          <h2>重新处理后生成</h2>
          <p>
            系统将重新处理本期时间范围内的全部资讯，完成后更新日报；原正式版保持可读，不发送邮件。
          </p>
          <form action={generateAction}>
            <input type="hidden" name="kind" value={previewKind.data} />
            <input type="hidden" name="date" value={String(query.date)} />
            <label className="check">
              <input type="checkbox" name="reprocess" defaultChecked />
              先重新处理资讯
            </label>
            <button className="solid-button">确认重新处理并生成</button>
          </form>
        </section>
      )}
      {pendingStatus && pendingStatus.pending > 0 && query.reprocess !== '1' && (
        <section className="admin-section" aria-labelledby="force-title">
          <h2 id="force-title">
            确认强制生成{previewKind.success ? kindNames[previewKind.data] : '简报'}
          </h2>
          <p>
            本期仍有 {pendingStatus.pending}{' '}
            篇资讯未完成。确认后会优先处理这些资讯，完成后自动生成本期简报。
          </p>
          <p>
            仍然失败且重试次数耗尽的资讯会被跳过并保留记录，不再阻塞出刊；模型调用计入每日额度，额度不足时等待恢复。
          </p>
          <p>发布方式：{config.autoPublish ? '生成成功直接发布' : '先保存待审稿'}。</p>
          <form action={generateAction} className="stack-form">
            <input type="hidden" name="kind" value={String(query.kind)} />
            <input type="hidden" name="date" value={String(query.date)} />
            <input type="hidden" name="force" value="true" />
            <label className="check">
              <input type="checkbox" name="confirmed" required />
              确认优先处理本期未完成资讯后强制生成
            </label>
            <button className="solid-button">确认强制生成</button>
          </form>
        </section>
      )}
      {preview && (
        <section className="admin-section">
          <h2>生成前确认</h2>
          <p>
            已选 {preview.count} 个事件 · 模型 {preview.model}。
            {pendingStatus?.failed
              ? `另有 ${pendingStatus.failed} 篇已达重试上限，跳过并保留失败记录。`
              : ''}
          </p>
          <p>
            {preview.cached
              ? '输入与已有成功结果一致，将复用缓存，不新增模型请求。'
              : '预计新增1—2次成稿请求，超长栏目按需压缩；失败请求也占用次数。'}
          </p>
          <p>发布方式：{config.autoPublish ? '生成成功直接发布' : '先保存待审稿'}。</p>
          <form action={generateAction}>
            <input type="hidden" name="kind" value={String(query.kind)} />
            <input type="hidden" name="date" value={String(query.date)} />
            <input type="hidden" name="expectedKey" value={preview.key} />
            <label className="check">
              <input type="checkbox" name="reprocess" />
              先重新处理资讯
            </label>
            <button className="solid-button">确认生成</button>
          </form>
        </section>
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
                      <form action={previewGenerateAction}>
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
