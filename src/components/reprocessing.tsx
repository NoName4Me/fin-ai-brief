import { reprocessRangeAction } from '../app/actions.ts';
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
export function Reprocessing() {
  const now = new Date();
  const previous = new Date(`${localDate(now)}T08:00:00+08:00`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return (
    <section aria-label="批量重新处理">
      <form action={reprocessRangeAction} className="stack-form settings-dialog-form">
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
          <select aria-label="处理范围" name="scope" defaultValue="outdated">
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
    </section>
  );
}
