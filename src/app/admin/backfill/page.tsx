import { PublicationTabs } from '../../../components/admin-page-tabs.tsx';
import { pool } from '../../../server/db.ts';
import { backfillPeriods, localDate } from '../../../server/periods.ts';
import { kindSchema } from '../../../server/types.ts';
import { requireAdmin } from '../../../server/auth.ts';
import { getSettings } from '../../../server/settings.ts';
import { backfillAction } from '../../actions.ts';
import { Notice, type Query } from '../../../components/notice.tsx';
export default async function Backfill({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const c = await getSettings();
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
      <Notice query={query} />
      <PublicationTabs active="backfill" />
      <section className="admin-section">
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
    </>
  );
}
