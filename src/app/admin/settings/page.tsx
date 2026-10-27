import { pool } from '../../../server/db.ts';
import { backfillPeriods, localDate } from '../../../server/periods.ts';
import { kindSchema } from '../../../server/types.ts';
import { modelUsage } from '../../../server/model.ts';
import { requireAdmin } from '../../../server/auth.ts';
import { getSettings } from '../../../server/settings.ts';
import { settingsAction, backfillAction } from '../../actions.ts';
import { Notice, type Query } from '../../../components/notice.tsx';
export default async function Settings({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const c = await getSettings();
  const usage = await modelUsage();
  const query = await searchParams;
  let preview: { kind: string; from: string; to: string; count: number } | undefined;
  let previewError = '';
  if (query.from && query.to && query.kind)
    try {
      const from = String(query.from),
        to = String(query.to),
        kind = kindSchema.parse(query.kind);
      if (from < c.startDate || to > localDate()) throw new Error('补刊范围须在起刊日期与今天之间');
      const periods = backfillPeriods(from, to, kind, c);
      const existing = await pool.query(
        'SELECT period_date::text date FROM briefs WHERE kind=$1 AND period_date BETWEEN $2 AND $3',
        [kind, from, to],
      );
      preview = {
        kind,
        from,
        to,
        count: periods.filter((p) => !existing.rows.some((e) => e.date === p.date)).length,
      };
    } catch (e) {
      previewError = e instanceof Error ? e.message : '日期无效';
    }
  return (
    <>
      <Notice query={await searchParams} />
      <form action={settingsAction} className="stack-form">
        <fieldset>
          <legend>任务处理</legend>
          <label>
            失败后自动重试次数
            <input
              type="number"
              name="taskRetryLimit"
              min={0}
              max={3}
              defaultValue={c.taskRetryLimit}
              required
            />
          </label>
          <label>
            资讯处理并发数
            <input
              type="number"
              name="processingConcurrency"
              min={1}
              max={20}
              defaultValue={c.processingConcurrency}
              required
            />
          </label>
          <label className="check">
            <input type="checkbox" name="reviewEnabled" defaultChecked={c.reviewEnabled} />
            启用疑难归组与事实复核
          </label>
          <p className="form-hint">
            默认重试1次（最多3次，0表示关闭），不包含首次执行。达到上限后标记失败，不阻塞出刊，可手动重新处理。邮件不自动重发。默认并发3篇，最多20篇；保存后后台自动应用，调整并发时先完成正在执行的任务。
          </p>
        </fieldset>
        <fieldset>
          <legend>自动采集</legend>
          <label className="check">
            <input type="checkbox" name="collectionEnabled" defaultChecked={c.collectionEnabled} />
            开启自动采集
          </label>
          <p className="form-hint">
            保存后生效，不需重启；只影响自动采集。正在执行的任务会完成，手动采集仍可用。
          </p>
        </fieldset>
        <fieldset>
          <legend>模型调用额度</legend>
          <p>
            今日已用 {usage.used} 次 / 上限 {usage.limit} 次，剩余 {usage.remaining} 次。
          </p>
          <label>
            每日调用次数上限
            <input
              type="number"
              name="modelDailyLimit"
              defaultValue={c.modelDailyLimit}
              min={1}
              max={100000}
              required
            />
          </label>
          <p className="form-hint">
            按北京时间每天零点重新计数，失败调用也计入。自动处理为出刊保留1次额度，额度不足的资讯继续等待；保存后
            Worker 下一轮自动继续。这是本站次数限制，服务商账户余额需在服务商处查看。
          </p>
        </fieldset>
        <fieldset>
          <legend>发布方式</legend>
          <label className="check">
            <input type="checkbox" name="autoPublish" defaultChecked={c.autoPublish} />
            生成成功后直接发布
          </label>
          <p className="form-hint">
            关闭时需管理员阅读并审核发布。修改只影响之后开始的生成任务，已有草稿不自动发布。
          </p>
        </fieldset>
        <fieldset>
          <legend>定时出刊</legend>
          <label>
            起刊日期
            <input type="date" name="startDate" defaultValue={c.startDate} required />
          </label>
          <div className="schedule-row">
            <label className="check">
              <input type="checkbox" name="dailyEnabled" defaultChecked={c.dailyEnabled} />
              日报
            </label>
            <label>
              截稿时间（北京时间）
              <input type="time" name="dailyTime" value="08:00" readOnly />
            </label>
          </div>
          <p className="form-hint">
            每天出刊，含周末和节假日。北京时间08:00截稿，取前一日08:00至当日08:00，生成完成后发布。
          </p>
        </fieldset>
        <label>
          简报主标题字数上限
          <input
            type="number"
            name="briefTitleMaxLength"
            min={1}
            max={200}
            defaultValue={c.briefTitleMaxLength}
            required
          />
          <span className="form-hint">含标点，适用于之后生成的简报；已有简报不截断、不重写。</span>
        </label>
        <label>
          每期最多事件数
          <input
            type="number"
            name="maxItems"
            defaultValue={c.maxItems}
            min={2}
            max={50}
            required
          />
        </label>
        <button className="solid-button">保存设置</button>
      </form>
      <section className="admin-section">
        <h2>手动补刊</h2>
        <p className="form-hint">补刊保存为待审稿；发布后不自动推送，可在订阅管理选择发送。</p>
        <form className="inline-form">
          <label>
            类型
            <select name="kind">
              <option value="daily">日报</option>
            </select>
          </label>
          <label>
            起始日期
            <input type="date" name="from" min={c.startDate} required />
          </label>
          <label>
            结束日期
            <input type="date" name="to" max={localDate()} required />
          </label>
          <button className="outline-button">预览补刊期数</button>
        </form>
        {previewError && <p className="notice error">{previewError}</p>}
        {preview && (
          <form action={backfillAction}>
            <p>
              所选范围缺少 {preview.count} 期，最多新增 {preview.count}{' '}
              次简报综合请求；相同输入可复用结果，未处理资讯需先处理。
            </p>
            <input type="hidden" name="kind" value={preview.kind} />
            <input type="hidden" name="from" value={preview.from} />
            <input type="hidden" name="to" value={preview.to} />
            <label className="check">
              <input name="confirmed" type="checkbox" required />
              确认范围与潜在调用量
            </label>
            <button className="outline-button" disabled={!preview.count}>
              确认补刊
            </button>
          </form>
        )}
      </section>
      <section className="admin-section">
        <h2>运行状态</h2>
        <p>模型：{process.env.LLM_MODEL || '未配置'}</p>
        <p>API 地址：{process.env.LLM_BASE_URL || '未配置'}</p>
        <p>
          采集：{c.collectionEnabled ? '已开启' : '未开启'}　模型调用：
          {process.env.MODEL_CALLS_ENABLED === 'true' ? '已开启' : '未开启'}　API Key：
          {process.env.LLM_API_KEY ? '已配置' : '未配置'}
        </p>
        <p>正式邮件：{process.env.MAIL_ENABLED === 'true' ? '已开启' : '待确认发信服务商'}</p>
      </section>
    </>
  );
}
