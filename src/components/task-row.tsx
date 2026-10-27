'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { ManagedTask, taskDetail } from '../server/admin-tasks.ts';
import { stageNames, stateNames, taskTypes, taskStamp } from '../server/task-labels.ts';
import { retryManagedTaskAction } from '../app/actions.ts';
import { assessmentSchema, ratingFor, defaultRatingRules } from '../server/editorial.ts';
type Detail = NonNullable<Awaited<ReturnType<typeof taskDetail>>>;
export function TaskRow({ task }: { task: ManagedTask }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const id = useId();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => request.current?.abort(), []);
  async function open() {
    dialog.current?.showModal();
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    setDetail(null);
    try {
      const response = await fetch(`/api/admin/tasks/${encodeURIComponent(task.id)}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '读取任务详情失败');
      if (!controller.signal.aborted) setDetail(result);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  const current = detail?.task ?? task;
  const assessment = assessmentSchema.safeParse(detail?.article?.assessment);
  const scoringRules = detail?.ratingRules ?? defaultRatingRules;
  const dimensionName = (key: string, rules = scoringRules) => {
    const rule = rules.find((r) => r.id === key);
    return rule ? `${rule.name}${rule.enabled ? '' : '（暂停）'}` : key;
  };
  const elapsed =
    current.started_on && current.completed_on
      ? Math.max(
          0,
          Math.round(
            (new Date(current.completed_on).getTime() - new Date(current.started_on).getTime()) /
              1000,
          ),
        )
      : null;
  return (
    <tr
      className="article-task-row"
      data-task-id={task.id}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button,a,dialog,input,select,summary,form'))
          return;
        void open();
      }}
    >
      <td>
        <span className="task-type">{taskTypes[task.queue]}</span>
      </td>
      <td className="task-name">{task.name}</td>
      <td className="task-time">{taskStamp(task.started_on)}</td>
      <td>
        <span className={'state-' + task.state}>{stateNames[task.state] ?? task.state}</span>
        {task.state === 'retry' && (
          <small>
            {task.retry_count} / {task.retry_limit} 次
          </small>
        )}
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
          {task.state === 'failed' && (
            <form action={retryManagedTaskAction}>
              <input type="hidden" name="taskId" value={task.id} />
              <button className="quiet-button">重试</button>
            </form>
          )}
        </div>
        <dialog
          id={id}
          ref={dialog}
          className="source-dialog task-dialog"
          aria-labelledby={`${id}-title`}
          onClose={() => request.current?.abort()}
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < bounds.left ||
              event.clientX > bounds.right ||
              event.clientY < bounds.top ||
              event.clientY > bounds.bottom
            )
              event.currentTarget.close();
          }}
        >
          <header className="dialog-header">
            <div>
              <h2 id={`${id}-title`}>任务详情</h2>
              <p>{task.name}</p>
            </div>
            <button
              type="button"
              className="dialog-close"
              aria-label="关闭任务详情"
              onClick={() => dialog.current?.close()}
            >
              关闭
            </button>
          </header>
          <div className="dialog-body">
            {loading && <p role="status">正在读取任务详情…</p>}
            {error && (
              <div role="alert">
                <p>{error}</p>
                <button className="outline-button" onClick={() => void open()}>
                  重新读取
                </button>
              </div>
            )}
            {detail && (
              <>
                <dl className="task-facts">
                  <div>
                    <dt>任务类型</dt>
                    <dd>{taskTypes[current.queue]}</dd>
                  </div>
                  <div>
                    <dt>状态</dt>
                    <dd>{stateNames[current.state] ?? current.state}</dd>
                  </div>
                  <div>
                    <dt>入队时间</dt>
                    <dd>{taskStamp(current.created_on)}</dd>
                  </div>
                  <div>
                    <dt>开始时间</dt>
                    <dd>{taskStamp(current.started_on)}</dd>
                  </div>
                  <div>
                    <dt>完成时间</dt>
                    <dd>{current.completed_on ? taskStamp(current.completed_on) : '未完成'}</dd>
                  </div>
                  <div>
                    <dt>耗时</dt>
                    <dd>
                      {elapsed === null ? '—' : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`}
                    </dd>
                  </div>
                  <div>
                    <dt>自动重试</dt>
                    <dd>
                      {current.retry_count} / {current.retry_limit} 次
                    </dd>
                  </div>
                  <div>
                    <dt>触发方式</dt>
                    <dd>
                      {current.request_id ||
                      current.data.manual ||
                      current.data.trigger === 'manual' ||
                      current.data.expectedKey
                        ? '手动'
                        : '自动'}
                    </dd>
                  </div>
                </dl>
                <p className="form-hint">任务ID：{current.id}</p>
                {current.error && <p className="notice error">{current.error}</p>}
                {current.state === 'failed' && current.queue === 'process' && (
                  <p>本条已停止自动处理，不再阻塞出刊；可在列表中重试。</p>
                )}
                {detail.source && (
                  <p>
                    信源：
                    <a href={detail.source.url} target="_blank" rel="noopener noreferrer">
                      {detail.source.name} ↗
                    </a>
                  </p>
                )}
                {detail.article && (
                  <>
                    <p>
                      资讯ID：{detail.article.id} · 来源：{detail.article.source_name}
                    </p>
                    <p>
                      发布时间：
                      {detail.article.published_precision === 'day'
                        ? taskStamp(detail.article.published_at).slice(0, 10) + '（时刻未披露）'
                        : taskStamp(detail.article.published_at)}
                    </p>
                    <p>
                      <a href={detail.article.url} target="_blank" rel="noopener noreferrer">
                        打开原文 ↗
                      </a>
                    </p>
                    <details className="task-stage">
                      <summary>原始摘要</summary>
                      <p>{detail.article.excerpt}</p>
                    </details>
                    {detail.article.event_title && <p>归组事件：{detail.article.event_title}</p>}
                    {assessment.success && (
                      <section className="task-stage">
                        <h3>
                          选题评分：{ratingFor(assessment.data, scoringRules) ?? '待重评'} / 5
                        </h3>
                        <dl>
                          {Object.entries(assessment.data).map(([key, value]) => (
                            <div key={key}>
                              <dt>
                                {dimensionName(key)}：{value.score}分
                              </dt>
                              <dd>{value.reason}</dd>
                            </div>
                          ))}
                        </dl>
                      </section>
                    )}
                    {detail.article.review_note && (
                      <p>复核／筛选说明：{detail.article.review_note}</p>
                    )}
                  </>
                )}
                {!!detail.edition.length && (
                  <section aria-label="栏目选题与出刊结果">
                    <h3>栏目选题与出刊结果</h3>
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
                          <details key={candidate.id}>
                            <summary>
                              {candidate.title}　
                              {candidate.rating === null ? '未评分' : `${candidate.rating}分`}　
                              {candidate.selected ? '已采用' : '未采用'}
                            </summary>
                            <p>{candidate.reason}</p>
                            {candidate.assessment && (
                              <dl>
                                {Object.entries(candidate.assessment).map(([key, value]) => (
                                  <div key={key}>
                                    <dt>
                                      {dimensionName(
                                        key,
                                        candidate.ratingRules ?? defaultRatingRules,
                                      )}
                                      ：{value.score}分
                                    </dt>
                                    <dd>{value.reason}</dd>
                                  </div>
                                ))}
                              </dl>
                            )}
                          </details>
                        ))}
                      </details>
                    ))}
                  </section>
                )}
                <h3>
                  {current.queue === 'process'
                    ? '处理步骤与历史（最新在前）'
                    : '任务时间线（最新在前）'}
                </h3>
                <div className="task-timeline">
                  {detail.steps
                    .filter((step) => step.stage !== 'edition')
                    .map((step) => (
                      <section className="task-stage" key={step.id}>
                        <h3>
                          {stageNames[step.stage] ?? step.stage}{' '}
                          <span className={'state-' + step.state}>
                            {stateNames[step.state] ?? step.state}
                          </span>
                        </h3>
                        <p>
                          开始：{taskStamp(step.started_at)} · 完成：
                          {step.finished_at ? taskStamp(step.finished_at) : '未完成'}
                        </p>
                        {step.error && <p className="notice error">{step.error}</p>}
                        {step.result != null && (
                          <details>
                            <summary>查看结果</summary>
                            <pre className="model-result">
                              {JSON.stringify(step.result, null, 2)}
                            </pre>
                          </details>
                        )}
                        {step.call_id && (
                          <details>
                            <summary>模型调用详情</summary>
                            <p>
                              {step.model} · 输入 {step.input_tokens ?? '未记录'} / 输出{' '}
                              {step.output_tokens ?? '未记录'} token
                            </p>
                            <details>
                              <summary>输入与提示词</summary>
                              <pre className="model-result">
                                {JSON.stringify(step.input_summary, null, 2)}
                              </pre>
                            </details>
                            <details>
                              <summary>模型结果</summary>
                              <pre className="model-result">
                                {JSON.stringify(step.response, null, 2)}
                              </pre>
                            </details>
                          </details>
                        )}
                      </section>
                    ))}
                </div>
                {!detail.steps.length && <p className="muted">暂无已记录的处理步骤。</p>}
              </>
            )}
          </div>
        </dialog>
      </td>
    </tr>
  );
}
