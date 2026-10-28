'use client';
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import type { ManagedTask } from '../server/admin-tasks.ts';
import type { batchDetail } from '../server/admin-reprocessing.ts';
import { taskStamp } from '../server/admin-task-labels.ts';
import { retryManagedTaskAction } from '../app/actions.ts';
type Detail = NonNullable<Awaited<ReturnType<typeof batchDetail>>>;
const labels: Record<string, string> = {
  waiting: '排队中',
  created: '排队中',
  processing: '处理中',
  active: '处理中',
  generating: '生成日报中',
  completed: '完成',
  succeeded: '完成',
  completed_with_errors: '完成，有失败项',
  failed: '失败',
  queued: '排队或处理中',
  waiting_articles: '等待本期资讯',
  waiting_budget: '等待额度',
  processed: '已归组',
  ignored: '已淘汰',
  retry: '等待重试',
  cancelled: '已取消',
};
export function BatchTaskRow({
  task,
  initiallyOpen = false,
}: {
  task: ManagedTask;
  initiallyOpen?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const id = useId();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function open() {
    if (!dialog.current?.open) dialog.current?.showModal();
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/admin/tasks/${encodeURIComponent(task.id)}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '读取批次失败');
      if (!controller.signal.aborted) setDetail(result);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    if (initiallyOpen) void open();
    return () => request.current?.abort();
  }, [initiallyOpen]);
  const done = (task.data.processed ?? 0) + (task.data.ignored ?? 0) + (task.data.failed ?? 0);
  const canRetry = ['failed', 'completed_with_errors'].includes(task.state);
  return (
    <tr
      className="article-task-row batch-task-row"
      data-task-id={task.id}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('button,a,dialog,form,input,select')) void open();
      }}
    >
      <td>
        <span className="task-type">批量重处理</span>
      </td>
      <td className="task-name">
        <span title={task.name}>{task.name}</span>
      </td>
      <td className="task-time">{taskStamp(task.started_on)}</td>
      <td>
        <span className={`state-${task.state}`}>{labels[task.state] ?? task.state}</span>
        <span className="batch-inline-progress">
          {done}/{task.data.total ?? 0}
        </span>
      </td>
      <td>
        <div className="row-actions">
          <button
            type="button"
            className="quiet-button"
            aria-haspopup="dialog"
            aria-controls={id}
            onClick={() => void open()}
          >
            详情
          </button>
          {canRetry && (
            <form action={retryManagedTaskAction}>
              <input type="hidden" name="taskId" value={task.id} />
              <button className="quiet-button">
                {task.state === 'failed' && !task.data.failed ? '重试生成' : '重试失败项'}
              </button>
            </form>
          )}
        </div>
        <dialog
          ref={dialog}
          id={id}
          className="source-dialog task-dialog batch-task-dialog"
          aria-labelledby={`${id}-title`}
          onClose={() => request.current?.abort()}
        >
          <header className="dialog-header">
            <div>
              <h2 id={`${id}-title`}>批量重处理详情</h2>
              <p>{task.name}</p>
            </div>
            <button className="dialog-close" type="button" onClick={() => dialog.current?.close()}>
              关闭
            </button>
          </header>
          <div className="dialog-body">
            <div className="batch-detail-actions">
              <button
                type="button"
                className="outline-button"
                disabled={loading}
                onClick={() => void open()}
              >
                刷新进度
              </button>
            </div>
            {loading && <p role="status">正在读取批次…</p>}
            {error && <p role="alert">{error}</p>}
            {detail && (
              <>
                <dl className="task-facts">
                  <div>
                    <dt>处理范围</dt>
                    <dd>
                      {taskStamp(detail.batch.range_start)}—{taskStamp(detail.batch.range_end)}
                    </dd>
                  </div>
                  <div>
                    <dt>状态</dt>
                    <dd>
                      {detail.batch.state === 'processing' &&
                      !detail.counts.waiting &&
                      !detail.counts.queued &&
                      detail.batch.date
                        ? '等待本期资讯'
                        : (labels[detail.batch.state] ?? detail.batch.state)}
                    </dd>
                  </div>
                  <div>
                    <dt>处理方式</dt>
                    <dd>
                      {detail.batch.scope === 'all' ? '范围内全部资讯' : '旧规则或失败的资讯'}
                    </dd>
                  </div>
                  <div>
                    <dt>后续出刊</dt>
                    <dd>
                      {detail.batch.date
                        ? `更新 ${detail.batch.date} 日报，不推送邮件`
                        : '仅重新处理资讯'}
                    </dd>
                  </div>
                </dl>
                <div className="batch-counts">
                  <span>总计 {detail.batch.total}</span>
                  <span>已归组 {detail.counts.processed}</span>
                  <span>淘汰 {detail.counts.ignored}</span>
                  <span className={detail.counts.failed ? 'overview-problem' : undefined}>
                    失败 {detail.counts.failed}
                  </span>
                  <span>待安排 {detail.counts.waiting}</span>
                  <span>排队或处理中 {detail.counts.queued}</span>
                </div>
                {detail.batch.error && <p className="notice error">{detail.batch.error}</p>}
                {detail.generation && (
                  <section className="batch-generation">
                    <h3>日报生成</h3>
                    <p>{labels[detail.generation.state] ?? detail.generation.state}</p>
                    {detail.generation.error && (
                      <p className="overview-problem">{detail.generation.error}</p>
                    )}
                    {detail.generation.brief_id && detail.generation.state === 'completed' && (
                      <div className="row-actions">
                        {detail.generation.has_draft && (
                          <Link href={`/admin/briefs/${detail.generation.brief_id}`}>
                            查看待审稿
                          </Link>
                        )}
                        {detail.generation.is_published && (
                          <Link href={`/briefs/${detail.generation.brief_id}`}>查看正式版</Link>
                        )}
                      </div>
                    )}
                  </section>
                )}
                {!!detail.edition.length && (
                  <section aria-label="本批次出刊栏目结果">
                    <h3>本批次出刊栏目结果</h3>
                    <p className="form-hint">{taskStamp(detail.batch.finished_at)}</p>
                    {detail.edition.map((section) => (
                      <details className="task-stage" key={section.section}>
                        <summary>
                          {section.section}　候选{section.candidate_count}条／采用
                          {section.selected_count}条　
                          {{
                            unscheduled: '未排期',
                            skipped: '正常跳过',
                            error: '处理异常',
                            ready: '待发布',
                            published: '已刊登',
                          }[section.status] ?? section.status}
                        </summary>
                        <p>{section.reason}</p>
                        {section.details.map((candidate) => (
                          <div key={candidate.id}>
                            <p>
                              {candidate.title}　
                              {candidate.rating === null ? '未评分' : `${candidate.rating}分`}　
                              {candidate.selected ? '已采用' : '未采用'}
                            </p>
                            <p className="form-hint">{candidate.reason}</p>
                          </div>
                        ))}
                      </details>
                    ))}
                  </section>
                )}
                <div className="table-wrap batch-items">
                  <table aria-label="批次逐条结果">
                    <thead>
                      <tr>
                        <th>资讯</th>
                        <th>状态</th>
                        <th>失败原因</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.items.map((item) => (
                        <tr key={item.id}>
                          <td>
                            {item.url ? (
                              <a href={item.url} target="_blank" rel="noreferrer">
                                {item.title}
                              </a>
                            ) : (
                              item.title
                            )}
                          </td>
                          <td className={item.state === 'failed' ? 'overview-problem' : undefined}>
                            {labels[item.state] ?? item.state}
                          </td>
                          <td>{item.error ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </dialog>
      </td>
    </tr>
  );
}
