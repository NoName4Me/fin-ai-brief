import Link from 'next/link';
import { requireAdmin } from '../../../server/auth.ts';
import { articleAction } from '../../actions.ts';
import { Notice, type Query } from '../../../components/notice.tsx';
import { taskOverview } from '../../../server/admin-tasks.ts';
import { taskTypes } from '../../../server/task-labels.ts';
import { TaskRow } from '../../../components/task-row.tsx';
import { Reprocessing } from '../../../components/reprocessing.tsx';
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
  };
  const state = typeof query.state === 'string' && query.state in states ? query.state : '';
  const [tasks] = await Promise.all([taskOverview(q, type, state)]);
  const params = new URLSearchParams({ q, type, state });
  return (
    <>
      <Notice query={query} />
      <Reprocessing selectedBatch={typeof query.batch === 'string' ? query.batch : undefined} />
      <details className="task-import">
        <summary>手工导入</summary>
        <form action={articleAction} className="stack-form">
          <label>
            标题
            <input name="title" required maxLength={500} />
          </label>
          <label>
            原文链接
            <input type="url" name="url" required />
          </label>
          <label>
            来源名称
            <input name="sourceName" required maxLength={200} />
          </label>

          <label>
            发布时间（北京时间）
            <input type="datetime-local" name="publishedAt" required />
          </label>
          <label>
            摘要
            <textarea name="excerpt" required maxLength={16000} rows={6} />
          </label>
          <button className="solid-button">导入资讯</button>
        </form>
      </details>

      <form className="inline-form task-filters" aria-label="任务筛选">
        <label>
          任务类型
          <select name="type" defaultValue={type}>
            <option value="">全部类型</option>
            {Object.entries(taskTypes).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          状态
          <select name="state" defaultValue={state}>
            <option value="">全部状态</option>
            {Object.entries(states).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          任务名
          <input
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
      <p className="form-hint">
        最近100个匹配任务，按入队时间倒序排列。时间为北京时间，未执行的任务显示“未开始”。
      </p>
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
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </tbody>
        </table>
      </div>
      {!tasks.length && <p className="empty-state">暂无匹配的任务。</p>}
    </>
  );
}
