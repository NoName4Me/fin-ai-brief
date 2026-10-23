import { isJiqizhixinRss } from '../../../server/source-access.ts';
import { requireAdmin } from '../../../server/auth.ts';
import { asc } from 'drizzle-orm';
import { db } from '../../../server/db.ts';
import { sources, industries } from '../../../server/schema.ts';
import { sourceAction, sourceRemoveAction, collectAction } from '../../actions.ts';
import { Notice, type Query } from '../../../components/notice.tsx';
function Fields({
  topics,
  row,
}: {
  topics: (typeof industries.$inferSelect)[];
  row?: typeof sources.$inferSelect;
}) {
  return (
    <>
      <input type="hidden" name="id" value={row?.id ?? ''} />
      <label>
        名称
        <input name="name" defaultValue={row?.name} required maxLength={200} />
      </label>
      <label>
        订阅地址
        <input type="url" name="url" defaultValue={row?.url} required placeholder="https://…" />
      </label>
      <label>
        行业
        <select name="industryId" defaultValue={row?.industryId}>
          {topics.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        格式
        <select name="format" defaultValue={row?.format ?? 'rss'}>
          <option value="rss">RSS / Atom</option>
          <option value="json">JSON</option>
          <option value="html">网页 / HTML</option>
        </select>
      </label>
      <label>
        采集间隔（分钟）
        <input
          type="number"
          name="intervalMinutes"
          min={row && isJiqizhixinRss(row.url) ? 60 : 5}
          max={1440}
          defaultValue={row?.intervalMinutes ?? 30}
          required
        />
      </label>
      <label className="check">
        <input type="checkbox" name="autoInterval" defaultChecked={row?.autoInterval} />
        自动调整采集间隔
      </label>
      <label>
        最短间隔（分钟）
        <input
          type="number"
          name="minIntervalMinutes"
          min={row && isJiqizhixinRss(row.url) ? 60 : 5}
          max={1440}
          defaultValue={row?.minIntervalMinutes ?? row?.intervalMinutes ?? 30}
          required
        />
      </label>
      <label>
        最长间隔（分钟）
        <input
          type="number"
          name="maxIntervalMinutes"
          min={row && isJiqizhixinRss(row.url) ? 60 : 5}
          max={1440}
          defaultValue={row?.maxIntervalMinutes ?? 240}
          required
        />
      </label>
      <label className="check">
        <input type="checkbox" name="enabled" defaultChecked={row?.enabled} />
        启用信源
      </label>
      <button className="solid-button">{row ? '保存信源' : '添加信源'}</button>
    </>
  );
}
export default async function Sources({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const [rows, topics] = await Promise.all([
    db.select().from(sources).orderBy(asc(sources.createdAt)),
    db.select().from(industries).orderBy(industries.position),
  ]);
  return (
    <>
      <Notice query={await searchParams} />
      <details className="admin-section" open={!rows.length}>
        <summary>添加信源</summary>
        <form action={sourceAction} className="stack-form">
          <Fields topics={topics} />
        </form>
        <p className="form-hint">
          JSON格式为数组，每条含
          title、url、excerpt、publishedAt（带时区的ISO时间）。RSS缺少明确时间的条目会跳过。AIHOT 的
          /api/v1/items
          接口同样选择JSON，系统会解析它的资讯列表和来源字段。网页采集支持新智元官方文章列表和上证报金融频道。
        </p>
      </details>
      {topics.map((topic) => {
        const group = rows.filter((row) => row.industryId === topic.id);
        return (
          <details key={topic.id} className="source-group" open>
            <summary>
              <h2>{topic.name}</h2>
              <span className="muted">
                {group.length} 个信源 · {group.filter((row) => row.enabled).length} 个启用
              </span>
            </summary>
            {group.length === 0 && <p className="form-hint">尚未配置信源</p>}
            {group.map((row) => (
              <details key={row.id} className="admin-section">
                <summary>
                  {row.name}
                  <span className="muted">
                    　{row.enabled ? '已启用' : '已停用'}　
                    {row.lastFetchedAt?.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) ??
                      '尚未采集'}
                  </span>
                </summary>
                <p>
                  当前间隔：{row.intervalMinutes}分钟 · {row.autoInterval ? '自动调频' : '固定间隔'}{' '}
                  · 下次：
                  {row.nextFetchAt?.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) ??
                    '待调度'}
                </p>
                <p className="form-hint">
                  {row.intervalReason ?? '尚无调频记录'}
                  。同站请求至少间隔1.5秒，429按服务端要求暂停；固定间隔来源也会在失败后暂时退避。
                </p>
                {row.lastError && <p className="notice error">{row.lastError}</p>}
                {isJiqizhixinRss(row.url) && (
                  <p className="form-hint">
                    官方RSS：采集间隔至少60分钟。访问令牌
                    {process.env.JIQIZHIXIN_RSS_TOKEN ? '已配置' : '未配置'}
                    ，保存在服务端，不在订阅地址中显示。
                  </p>
                )}
                <form action={sourceAction} className="stack-form">
                  <Fields topics={topics} row={row} />
                </form>
                <div className="row-actions">
                  <form action={collectAction}>
                    <input type="hidden" name="id" value={row.id} />
                    <button className="outline-button">立即采集</button>
                  </form>
                  <form action={sourceRemoveAction}>
                    <input type="hidden" name="id" value={row.id} />
                    <button className="quiet-button">删除信源</button>
                  </form>
                </div>
              </details>
            ))}
          </details>
        );
      })}
    </>
  );
}
