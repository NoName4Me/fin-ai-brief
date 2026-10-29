import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSettings } from '../../../server/settings.ts';
import { TaskSettingsForm } from '../../../components/settings-forms.tsx';
import { SourceManagementDialog } from '../../../components/source-management-dialog.tsx';
import { requireAdmin } from '../../../server/auth.ts';
import { Notice, type Query } from '../../../components/notice.tsx';
import { taskOverview } from '../../../server/admin-tasks.ts';
import { taskTypes } from '../../../server/admin-task-labels.ts';
import { BatchTaskRow } from '../../../components/batch-task-row.tsx';
import { TaskRow } from '../../../components/task-row.tsx';
import { Reprocessing } from '../../../components/reprocessing.tsx';
import { ManualImport } from '../../../components/manual-import.tsx';
export const metadata = { title: '任务管理' };
export default async function Tasks({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const query = await searchParams;
  const q = typeof query.q === 'string' ? query.q : '';
  const type = typeof query.type === 'string' && query.type in taskTypes ? query.type : '';
  const states = {
    created: '排队中',
    active: '执行中',
    retry: '等待重试',
    waiting_articles: '等待资讯处理',
    waiting_budget: '等待额度',
    succeeded: '成功',
    failed: '失败',
    cancelled: '已取消',
    generating: '生成日报中',
    completed_with_errors: '完成，有失败项',
  };
  const state = typeof query.state === 'string' && query.state in states ? query.state : '';
  const page = Math.max(1, Math.min(1000000, Number.parseInt(String(query.page), 10) || 1));
  let [tasks, config] = await Promise.all([taskOverview(q, type, state, page, 50), getSettings()]);
  const params = new URLSearchParams({
    q,
    type,
    state,
    ...(page > 1 ? { page: String(page) } : {}),
  });
  if (!tasks.length && page > 1) {
    const first = await taskOverview(q, type, state, 1, 50);
    const last = Math.max(1, Math.ceil((first[0]?.total_count ?? 0) / 50));
    redirect(`/admin/articles?${new URLSearchParams({ q, type, state, page: String(last) })}`);
  }
  const total = tasks[0]?.total_count ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));
  const pageHref = (value: number) =>
    `/admin/articles?${new URLSearchParams({ q, type, state, page: String(value) })}`;
  return (
    <>
      <Notice query={query} />
      <div className="admin-page-actions task-management-actions">
        <Link
          className="outline-button"
          href={`/admin/articles?${params}&configure=import`}
          scroll={false}
        >
          手工录入资讯
        </Link>
        <Link
          className="solid-button"
          href={`/admin/articles?${params}&configure=reprocess`}
          scroll={false}
        >
          批量重新处理
        </Link>
        <Link
          className="outline-button"
          href={`/admin/articles?${params}&configure=tasks`}
          scroll={false}
        >
          任务处理配置
        </Link>
      </div>
      {query.configure === 'import' && (
        <SourceManagementDialog title="手工录入资讯" closeHref={`/admin/articles?${params}`}>
          <ManualImport />
        </SourceManagementDialog>
      )}
      {query.configure === 'tasks' && (
        <SourceManagementDialog title="任务处理配置" closeHref={`/admin/articles?${params}`}>
          <TaskSettingsForm config={config} />
        </SourceManagementDialog>
      )}
      {query.configure === 'reprocess' && (
        <SourceManagementDialog title="批量重新处理" closeHref={`/admin/articles?${params}`}>
          <Reprocessing />
        </SourceManagementDialog>
      )}
      <form className="inline-form task-filters" aria-label="任务筛选">
        <label>
          <select aria-label="任务类型" name="type" defaultValue={type}>
            <option value="">全部类型</option>
            {Object.entries(taskTypes).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <select aria-label="状态" name="state" defaultValue={state}>
            <option value="">全部状态</option>
            {Object.entries(states).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            aria-label="任务名"
            name="q"
            type="search"
            maxLength={200}
            defaultValue={q}
            placeholder="搜索信源、资讯或刊期"
          />
        </label>
        <button className="solid-button">筛选</button>
        <Link href={`/admin/articles?${params}`} className="outline-button">
          刷新
        </Link>
      </form>

      <div className="table-wrap">
        <table className="managed-task-table" aria-label="任务列表">
          <thead>
            <tr>
              <th>任务类型</th>
              <th>任务名</th>
              <th>开始时间</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) =>
              task.queue === 'reprocess' ? (
                <BatchTaskRow
                  key={task.id}
                  task={task}
                  initiallyOpen={query.batch === task.target_id}
                />
              ) : (
                <TaskRow key={task.id} task={task} />
              ),
            )}
          </tbody>
        </table>
      </div>
      <nav className="pagination" aria-label="任务分页">
        <span>
          共{total}条 · 第{page}/{pages}页
        </span>
        {page > 1 ? (
          <Link href={pageHref(page - 1)}>上一页</Link>
        ) : (
          <span aria-disabled="true">上一页</span>
        )}
        {page < pages ? (
          <Link href={pageHref(page + 1)}>下一页</Link>
        ) : (
          <span aria-disabled="true">下一页</span>
        )}
      </nav>
      {!tasks.length && <p className="empty-state">暂无匹配的任务。</p>}
    </>
  );
}
