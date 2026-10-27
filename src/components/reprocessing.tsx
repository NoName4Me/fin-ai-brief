import Link from 'next/link';
import { reprocessRangeAction } from '../app/actions.ts';
import { reprocessingBatches } from '../server/reprocessing.ts';
import { localDate } from '../server/periods.ts';
const localInput = (date: Date) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(date)
    .replace(' ', 'T');
const stamp = (date: Date | string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(date));
const labels: Record<string, string> = {
  waiting: '待安排',
  processing: '处理中',
  generating: '更新日报中',
  completed: '已完成',
  completed_with_errors: '已完成，部分失败',
  failed: '失败',
  queued: '排队或处理中',
  processed: '已归组',
  ignored: '已淘汰',
};
export async function Reprocessing({ selectedBatch }: { selectedBatch?: string }) {
  const batches = await reprocessingBatches();
  const now = new Date();
  const previous = new Date(`${localDate(now)}T08:00:00+08:00`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return (
    <section aria-label="批量重新处理">
      <details className="task-import">
        <summary>按时间范围重新处理</summary>
        <form action={reprocessRangeAction} className="stack-form">
          <label>
            起始时间（北京时间）
            <input type="datetime-local" name="from" defaultValue={localInput(previous)} required />
          </label>
          <label>
            结束时间（北京时间）
            <input type="datetime-local" name="to" defaultValue={localInput(now)} required />
          </label>
          <label>
            处理范围
            <select name="scope" defaultValue="outdated">
              <option value="outdated">旧规则或失败的资讯</option>
              <option value="all">范围内全部资讯</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" name="regenerate" />
            完成后更新指定日报，不发送邮件
          </label>
          <label>
            更新日报日期
            <input type="date" name="regenerateDate" defaultValue={localDate(now)} />
          </label>
          <p className="form-hint">
            系统按当前规则重新筛选、评分和归组，沿用模型额度与并发设置。单批最多500条，时间范围最多31天。
          </p>
          <button className="solid-button">创建重新处理任务</button>
        </form>
      </details>
      {!!batches.length && (
        <div className="reprocessing-history">
          <h2>重新处理批次</h2>
          {batches.map((batch) => (
            <details className="task-stage" key={batch.id} open={selectedBatch === batch.id}>
              <summary>
                {stamp(batch.range_start)}—{stamp(batch.range_end)}　
                {labels[batch.state] ?? batch.state}　
                {batch.processed + batch.ignored + batch.failed}/{batch.total}条
              </summary>
              <p>
                待安排{batch.waiting}条，排队或处理中{batch.queued}条，已归组{batch.processed}
                条，淘汰
                {batch.ignored}条，失败{batch.failed}条。
              </p>
              {batch.date && <p>完成后更新{batch.date}日报，不发送邮件。</p>}
              {batch.error && <p className="notice error">{batch.error}</p>}
              <details>
                <summary>查看逐条结果</summary>
                <ol>
                  {batch.items.map((item) => (
                    <li key={item.article_id ?? item.title}>
                      <Link href={`/admin/articles?q=${encodeURIComponent(item.title)}`}>
                        {item.title}
                      </Link>
                      　{labels[item.state] ?? item.state}
                      {item.error && <span>：{item.error}</span>}
                    </li>
                  ))}
                </ol>
              </details>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
