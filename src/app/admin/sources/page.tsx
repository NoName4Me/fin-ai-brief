import Link from 'next/link';
import { isJiqizhixinRss } from '../../../server/source-access.ts';
import { requireAdmin } from '../../../server/auth.ts';
import { asc } from 'drizzle-orm';
import { db, pool } from '../../../server/db.ts';
import { sources } from '../../../server/schema.ts';
import {
  sourceAction,
  sourceRemoveAction,
  collectAction,
  sourceVerifyAction,
} from '../../actions.ts';
import { Notice, type Query } from '../../../components/notice.tsx';
import { SourceSwitch } from '../../../components/source-switch.tsx';
import { SourceFilters } from '../../../components/source-filters.tsx';
import { SourceManagementDialog } from '../../../components/source-management-dialog.tsx';
import { getSettings } from '../../../server/settings.ts';
import { verificationLabels } from '../../../server/source-config.ts';
const formatLabels: Record<string, string> = {
  rss: 'RSS / Atom',
  json: '公开接口',
  html: '网页',
  manual: '待接入',
};
const date = (value: Date | null) =>
  value?.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) ?? '—';
function Fields({
  row,
  sections,
}: {
  row?: typeof sources.$inferSelect;
  sections: { name: string }[];
}) {
  return (
    <>
      <input type="hidden" name="id" value={row?.id ?? ''} />
      <label>
        名称
        <input name="name" defaultValue={row?.name} required maxLength={200} />
      </label>
      <label>
        来源地址或账号
        <input name="originAddress" defaultValue={row?.originAddress} maxLength={2000} />
      </label>
      <fieldset className="source-sections source-field-wide">
        <legend>归属栏目</legend>
        {sections.map(({ name }) => (
          <label className="check" key={name}>
            <input
              type="checkbox"
              name="sections"
              value={name}
              defaultChecked={row?.sections.includes(name)}
            />
            {name}
          </label>
        ))}
        <p className="form-hint">不选表示通用，参与所有栏目的候选。</p>
      </fieldset>
      <label>
        采集方式
        <select name="format" defaultValue={row?.format ?? 'manual'}>
          <option value="manual">待接入</option>
          <option value="rss">RSS / Atom</option>
          <option value="json">公开接口 / JSON</option>
          <option value="html">网页 / HTML</option>
        </select>
      </label>
      <label>
        采集入口
        <input
          type="url"
          name="url"
          defaultValue={row?.url ?? ''}
          placeholder="https://…"
          maxLength={2000}
        />
      </label>
      <label>
        优先级
        <select name="priority" defaultValue={row?.priority ?? 'P1'}>
          <option>P0</option>
          <option>P1</option>
          <option>P2</option>
        </select>
      </label>
      <label>
        验证状态
        <select name="verificationStatus" defaultValue={row?.verificationStatus ?? 'pending'}>
          {Object.entries(verificationLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        验证与选用结论
        <textarea name="verificationNote" defaultValue={row?.verificationNote} maxLength={2000} />
      </label>
      <label>
        备注
        <textarea name="notes" defaultValue={row?.notes} maxLength={4000} />
      </label>
      <fieldset className="source-rhythm source-field-wide">
        <legend>采集节奏</legend>
        <label>
          采集间隔（分钟）
          <input
            type="number"
            name="intervalMinutes"
            min={isJiqizhixinRss(row?.url ?? null) ? 60 : 5}
            max={1440}
            defaultValue={row?.intervalMinutes ?? 60}
            required
          />
        </label>
        <label>
          最短间隔（分钟）
          <input
            type="number"
            name="minIntervalMinutes"
            min={isJiqizhixinRss(row?.url ?? null) ? 60 : 5}
            max={1440}
            defaultValue={row?.minIntervalMinutes ?? 60}
            required
          />
        </label>
        <label>
          最长间隔（分钟）
          <input
            type="number"
            name="maxIntervalMinutes"
            min={5}
            max={1440}
            defaultValue={row?.maxIntervalMinutes ?? 240}
            required
          />
        </label>
        <label className="check">
          <input type="checkbox" name="autoInterval" defaultChecked={row?.autoInterval} />
          自动调整采集间隔
        </label>
      </fieldset>
    </>
  );
}
export default async function Sources({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const query = await searchParams;
  const sections = (await getSettings()).sections.filter((s) => s.kind === 'fixed');
  const rows = await db.select().from(sources).orderBy(asc(sources.createdAt), asc(sources.id));
  const selected = rows.find((row) => row.id === query.detail);
  const enabledFilter = query.enabled === 'true' || query.enabled === 'false' ? query.enabled : '';
  const sectionFilter =
    typeof query.section === 'string' &&
    (query.section === 'general' || sections.some((s) => s.name === query.section))
      ? query.section
      : '';
  const formatFilter =
    typeof query.format === 'string' && Object.hasOwn(formatLabels, query.format)
      ? query.format
      : '';
  const visibleRows = rows.filter(
    (row) =>
      (!enabledFilter || row.enabled === (enabledFilter === 'true')) &&
      (!sectionFilter ||
        (sectionFilter === 'general'
          ? !row.sections.length
          : row.sections.includes(sectionFilter))) &&
      (!formatFilter || row.format === formatFilter),
  );
  const listQuery = new URLSearchParams();
  if (enabledFilter) listQuery.set('enabled', enabledFilter);
  if (sectionFilter) listQuery.set('section', sectionFilter);
  if (formatFilter) listQuery.set('format', formatFilter);
  const listHref = `/admin/sources${listQuery.size ? `?${listQuery}` : ''}`;
  const quality =
    await pool.query(`WITH recent AS (SELECT * FROM articles WHERE published_at >= now()-interval '30 days'), repeated AS
    (SELECT event_id FROM recent WHERE event_id IS NOT NULL GROUP BY event_id HAVING count(DISTINCT source_id)>1)
    SELECT source_id,count(*)::int total,count(*) FILTER(WHERE state='ignored')::int ignored,
    count(*) FILTER(WHERE event_id IN (SELECT event_id FROM repeated))::int repeated FROM recent GROUP BY source_id`);
  const metric = quality.rows.find((q) => q.source_id === selected?.id);
  return (
    <>
      <Notice query={query} />
      <div className="source-toolbar">
        <Link
          className="solid-button"
          scroll={false}
          href={`${listHref}${listQuery.size ? '&' : '?'}add=1`}
        >
          添加信源
        </Link>
      </div>
      {query.add === '1' && !selected && (
        <SourceManagementDialog key="add" title="添加信源" closeHref={listHref}>
          <form
            action={sourceAction}
            className="stack-form source-config-form"
            id="source-config-form"
          >
            <Fields sections={sections} />
          </form>
          <footer className="source-management-footer">
            <button className="solid-button" form="source-config-form">
              添加信源
            </button>
          </footer>
        </SourceManagementDialog>
      )}
      {selected && (
        <SourceManagementDialog
          key={selected.id}
          title={`${selected.name}详情`}
          closeHref={listHref}
        >
          <div className="source-meta">
            <p className="form-hint">
              最近验证：{date(selected.verifiedAt)} · 下次采集：{date(selected.nextFetchAt)}
            </p>
            {metric && (
              <p className="form-hint">
                近30天采入{metric.total}篇，关联性淘汰{metric.ignored}篇，涉及跨源重复事件
                {metric.repeated}篇。
              </p>
            )}
            {selected.intervalReason && <p className="form-hint">{selected.intervalReason}</p>}
            {selected.lastError && <p className="notice error">{selected.lastError}</p>}
            {isJiqizhixinRss(selected.url) && (
              <p className="form-hint">
                官方RSS每60分钟最多请求一次。访问令牌
                {process.env.JIQIZHIXIN_RSS_TOKEN ? '已配置' : '未配置'}。
              </p>
            )}
          </div>
          <form
            action={sourceAction}
            className="stack-form source-config-form"
            id="source-config-form"
          >
            <Fields row={selected} sections={sections} />
          </form>
          <footer className="source-management-footer">
            <div className="row-actions">
              <form action={sourceVerifyAction}>
                <input type="hidden" name="id" value={selected.id} />
                <button className="outline-button">验证采集</button>
              </form>
              <form action={collectAction}>
                <input type="hidden" name="id" value={selected.id} />
                <button className="outline-button" disabled={!selected.enabled || !selected.url}>
                  立即采集
                </button>
              </form>
              <form action={sourceRemoveAction}>
                <input type="hidden" name="id" value={selected.id} />
                <button className="quiet-button">删除信源</button>
              </form>
            </div>
            <button className="solid-button" form="source-config-form">
              保存信源
            </button>
          </footer>
        </SourceManagementDialog>
      )}
      <SourceFilters
        enabled={enabledFilter}
        section={sectionFilter}
        format={formatFilter}
        sections={sections.map((s) => s.name)}
        formats={formatLabels}
      />
      <p className="form-hint">
        {rows.length}个信源 · {rows.filter((s) => s.enabled).length}个启用
      </p>
      <div
        className="table-wrap source-table-wrap"
        id="sources-table"
        role="region"
        aria-label="信源列表"
        tabIndex={0}
      >
        <table className="source-table">
          <thead>
            <tr>
              {['信源名称', '归属栏目', '采集方式', '验证状态', '最近采集', '启用', '操作'].map(
                (name) => (
                  <th key={name} scope="col">
                    {name}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={row.id} data-source-id={row.id}>
                <td>{row.name}</td>
                <td>{row.sections.length ? row.sections.join('、') : '通用'}</td>
                <td>{formatLabels[row.format] ?? row.format}</td>
                <td>{verificationLabels[row.verificationStatus]}</td>
                <td>
                  <time>{date(row.lastFetchedAt)}</time>
                  {row.lastError && <small>采集异常</small>}
                </td>
                <td>
                  <SourceSwitch
                    id={row.id}
                    name={row.name}
                    enabled={row.enabled}
                    canEnable={
                      !!row.url && row.format !== 'manual' && row.verificationStatus === 'approved'
                    }
                  />
                </td>
                <td>
                  <Link
                    scroll={false}
                    href={`${listHref}${listQuery.size ? '&' : '?'}detail=${row.id}`}
                  >
                    详情
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visibleRows.length && (
          <p className="form-hint">{rows.length ? '没有符合筛选条件的信源' : '尚未添加信源'}</p>
        )}
      </div>
    </>
  );
}
