import Link from 'next/link';
import { requireAdmin } from '../../../../server/auth.ts';
import {
  sourceQualityData,
  sourceDayRuns,
  sourceOverlap,
} from '../../../../server/source-metrics.ts';
import { pool } from '../../../../server/db.ts';
import { getSettings } from '../../../../server/settings.ts';
import { taskStamp } from '../../../../server/task-labels.ts';
import { localDate, validDate, publicationCycle } from '../../../../server/periods.ts';
import { sourceReviewAction } from '../../../actions.ts';
import { Notice, type Query } from '../../../../components/notice.tsx';
const verdicts = {
  keep: '保留',
  scope: '调整栏目范围',
  slower: '降低采集频率',
  stop: '考虑停用',
  observe: '继续观察',
};
const evidenceKinds = {
  unknown: '待核查',
  original: '原始来源',
  reprint: '转载',
  aggregator: '聚合',
};
const completenessKinds = {
  unknown: '待核查',
  sufficient: '材料充分',
  thin: '摘要偏少',
  title: '标题为主',
};
const outcomes: Record<string, string> = {
  new: '新增采集',
  known: '全库已有',
  repeated: '再次出现',
  outside_window: '超出采集时间窗口',
  invalid: '无有效内容',
  failed: '采集失败',
};
const relations = { new: '新事件', update: '新进展', duplicate: '重复报道' };
const filters: Record<string, string> = {
  '': '全部结果',
  inserted: '新增采集',
  highlights: '进入要览',
  processed: '筛选通过',
  ignored: '淘汰',
  pending: '待处理',
  failed: '处理失败',
  removed: '原始资讯已清理',
  invalid: '无有效内容',
  qualified: '合格事件',
  selected: '日报采用',
  duplicate: '重复报道',
  exclusive: '独家覆盖',
};
export default async function Page({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const query = await searchParams;
  const cycleStart =
    query.status === 'cycle_error'
      ? publicationCycle(new Date(), (await getSettings()).dailyTime).start
      : null;
  const days = query.days === '7' ? 7 : 30;
  const date =
    typeof query.date === 'string' && validDate(query.date) && query.date <= localDate()
      ? query.date
      : localDate();
  const source = typeof query.source === 'string' ? query.source : '';
  const search = typeof query.q === 'string' ? query.q.slice(0, 200) : '';
  const periodView = query.view === 'period' && !query.date;
  const data = await sourceQualityData(days, source && !periodView ? date : undefined);
  const selected = data.metrics.find((s) => s.id === source);
  const overlaps = selected ? [] : await sourceOverlap(days);
  const enabledFilter = ['disabled', 'all'].includes(String(query.enabled))
    ? String(query.enabled)
    : 'enabled';
  const statusFilter = ['abnormal', 'healthy', 'zero', 'cycle_error'].includes(String(query.status))
    ? String(query.status)
    : '';
  const sort = ['selected', 'discovered', 'relevant', 'recent'].includes(String(query.sort))
    ? String(query.sort)
    : 'order';
  const metrics = data.metrics
    .filter(
      (s) =>
        (enabledFilter === 'all' || (enabledFilter === 'disabled' ? !s.enabled : s.enabled)) &&
        (!search || s.name.toLowerCase().includes(search.toLowerCase())) &&
        (!statusFilter ||
          (statusFilter === 'cycle_error'
            ? !!s.last_error && !!s.last_fetched_at && s.last_fetched_at >= cycleStart!
            : statusFilter === 'abnormal'
              ? ['failed', 'retry', 'overdue'].includes(s.source_state)
              : statusFilter === 'healthy'
                ? s.source_state === 'healthy'
                : s.discovered > 0 && s.selected === 0)),
    )
    .sort((a, b) => {
      if (sort === 'selected') return b.selected - a.selected || b.discovered - a.discovered;
      if (sort === 'discovered') return b.discovered - a.discovered;
      if (sort === 'relevant') return b.relevant - a.relevant;
      if (sort === 'recent')
        return (b.last_fetched_at?.getTime() ?? 0) - (a.last_fetched_at?.getTime() ?? 0);
      return 0;
    });
  const sourceItems = data.discoveries.filter((r) => r.source_id === source);
  const filter = typeof query.result === 'string' && query.result in filters ? query.result : '';
  const items = sourceItems.filter(
    (r) =>
      (!search || r.title.toLowerCase().includes(search.toLowerCase())) &&
      (!filter ||
        (filter === 'inserted'
          ? r.inserted
          : filter === 'highlights'
            ? r.highlight
            : filter === 'qualified'
              ? r.qualified
              : filter === 'selected'
                ? r.selected
                : filter === 'exclusive'
                  ? r.qualified && !r.peers.some((p) => p.qualified)
                  : filter === 'duplicate'
                    ? r.relation === 'duplicate'
                    : (r.state ?? 'pending') === filter)),
  );
  const page = Math.max(
    1,
    Math.min(
      Number.parseInt(String(query.page), 10) || 1,
      Math.max(1, Math.ceil(items.length / 50)),
    ),
  );
  const [runs, reviews] = selected
    ? await Promise.all([
        sourceDayRuns(source, date),
        pool.query<{
          id: string;
          created_at: Date;
          verdict: keyof typeof verdicts;
          evidence_kind: keyof typeof evidenceKinds;
          completeness: keyof typeof completenessKinds;
          note: string;
          urls: string[];
        }>('SELECT * FROM source_reviews WHERE source_id=$1 ORDER BY created_at DESC LIMIT 30', [
          source,
        ]),
      ])
    : [[], { rows: [] }];
  const detailHref = (extra: Record<string, string>) =>
    `/admin/sources/monitor?${new URLSearchParams({ source, ...(periodView ? { view: 'period' } : { date }), days: String(days), result: filter, q: search, ...extra })}`;
  const percent = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
  return (
    <div className="source-monitor">
      <Notice query={query} />
      {selected ? (
        <>
          <div className="admin-page-actions">
            <Link href={`/admin/sources/monitor?days=${days}`} className="outline-button">
              全部信源
            </Link>
            <Link href={`/admin/sources?detail=${source}`} className="outline-button">
              信源设置
            </Link>
            <Link href={`?source=${source}&view=period&days=${days}`}>近{days}天</Link>
          </div>
          <div className="source-detail-heading">
            <strong>{selected.name}</strong>
            <span>
              首次发现{selected.discovered}条 · 新增采集{selected.inserted}条 · 筛选通过
              {selected.relevant}条 · 淘汰{selected.ignored}条 · 待处理{selected.pending}条 · 失败
              {selected.failed}条 · 日报采用{selected.selected}个事件
            </span>
          </div>
          <form className="inline-form source-day-filters" aria-label="每日采集筛选">
            <input type="hidden" name="view" value={periodView ? 'period' : 'day'} />
            <input type="hidden" name="source" value={source} />
            <input type="hidden" name="days" value={days} />
            <input
              type="date"
              aria-label="采集日期"
              name="date"
              defaultValue={periodView ? '' : date}
              max={localDate()}
            />
            <select name="result" aria-label="处理结果" defaultValue={filter}>
              {Object.entries(filters).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <input
              type="search"
              aria-label="搜索标题"
              name="q"
              defaultValue={search}
              placeholder="搜索标题"
              maxLength={200}
            />
            <button className="solid-button">筛选</button>
          </form>
          <div className="table-wrap">
            <table className="discovery-table" aria-label="每日采集明细">
              <thead>
                <tr>
                  <th>首次发现</th>
                  <th>标题</th>
                  <th>资讯时间</th>
                  <th>处理结果</th>
                  <th>事件关系</th>
                  <th>日报采用</th>
                </tr>
              </thead>
              <tbody>
                {items.slice((page - 1) * 50, page * 50).map((r) => (
                  <tr key={r.url}>
                    <td>{taskStamp(r.first_seen_at)}</td>
                    <td>
                      <details>
                        <summary>{r.title}</summary>
                        <div className="discovery-detail">
                          <a href={r.url} target="_blank" rel="noreferrer">
                            原文
                          </a>
                          {r.snapshot && (
                            <>
                              <p>{r.excerpt?.split('\n').slice(0, 3).join(' ')}</p>
                              <ol>
                                {r.snapshot.entries.map((entry) => (
                                  <li key={entry.key} value={entry.rank}>
                                    <a href={entry.url} target="_blank" rel="noreferrer">
                                      {entry.name}
                                    </a>
                                    {entry.score !== undefined ? ` · 得分 ${entry.score}` : ''}
                                    {entry.metric ? ` · ${entry.metric}` : ''}
                                    {entry.description && <p>{entry.description}</p>}
                                  </li>
                                ))}
                              </ol>
                            </>
                          )}
                          {r.review_note && <p>{r.review_note}</p>}
                          {r.rating !== null && (
                            <p>
                              评分 {r.rating.toFixed(2)} ·{' '}
                              {r.qualified ? '达到选题分数' : '未达到选题分数'}
                            </p>
                          )}
                          {r.event_title && <p>事件：{r.event_title}</p>}
                          {r.peers.length > 0 && (
                            <>
                              <p>共同报道</p>
                              <ul>
                                {r.peers.map((p) => (
                                  <li key={`${p.source_id}:${p.url}`}>
                                    <Link
                                      href={`/admin/sources/monitor?source=${p.source_id}&date=${localDate(new Date(p.first_seen_at))}`}
                                    >
                                      {p.name}
                                    </Link>{' '}
                                    · {taskStamp(p.first_seen_at)} ·{' '}
                                    {p.development ? '提供事实进展' : '共同报道'} ·{' '}
                                    <a href={p.url} target="_blank" rel="noreferrer">
                                      {p.title}
                                    </a>
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                        </div>
                      </details>
                    </td>
                    <td>
                      {r.published_precision === 'observed' ? '采集于 ' : ''}
                      {r.published_at ? taskStamp(r.published_at) : '—'}
                    </td>
                    <td>
                      {(
                        {
                          processed: '通过',
                          ignored: '淘汰',
                          pending: '待处理',
                          failed: '失败',
                          removed: '已清理',
                          invalid: '无有效内容',
                        } as Record<string, string>
                      )[r.state ?? 'pending'] ?? r.state}
                    </td>
                    <td>{r.relation ? relations[r.relation] : '—'}</td>
                    <td>
                      {r.selected
                        ? r.editions.map((b) => (
                            <Link key={b.id} href={`/briefs/${b.id}`}>
                              {b.date}
                            </Link>
                          ))
                        : r.state === 'ignored'
                          ? '—'
                          : r.has_edition
                            ? '未采用'
                            : '尚无正式出刊结果'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!items.length && <p className="empty-state">暂无匹配资讯。</p>}
          <nav className="pagination" aria-label="采集明细分页">
            <span>
              共{items.length}条 · 第{page}/{Math.max(1, Math.ceil(items.length / 50))}页
            </span>
            {page > 1 && <Link href={detailHref({ page: String(page - 1) })}>上一页</Link>}
            {page * 50 < items.length && (
              <Link href={detailHref({ page: String(page + 1) })}>下一页</Link>
            )}
          </nav>
          <details className="admin-section">
            <summary>每轮采集记录（{runs.length}次）</summary>
            {runs.map((run) => (
              <details key={run.id} className="collection-run">
                <summary>
                  {taskStamp(run.started_at)} ·{' '}
                  {run.state === 'succeeded' ? '成功' : run.state === 'failed' ? '失败' : '执行中'}{' '}
                  · {run.items.length}条
                </summary>
                {run.error && <p className="notice error">{run.error}</p>}
                <ul>
                  {run.items.map((item, index) => (
                    <li key={index}>
                      <span>{outcomes[item.outcome]} · </span>
                      {item.url && /^https?:/.test(item.url) ? (
                        <a href={item.url} target="_blank" rel="noreferrer">
                          {item.title}
                        </a>
                      ) : (
                        item.title
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </details>
          <details className="admin-section">
            <summary>人工评价</summary>
            <form action={sourceReviewAction} className="stack-form source-review-form">
              <input type="hidden" name="sourceId" value={source} />
              <input type="hidden" name="date" value={date} />
              <div className="review-selects">
                <label>
                  评价
                  <select name="verdict" aria-label="评价" defaultValue="observe">
                    {Object.entries(verdicts).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  来源性质
                  <select name="evidenceKind" aria-label="来源性质">
                    {Object.entries(evidenceKinds).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  材料完整度
                  <select name="completeness" aria-label="材料完整度">
                    {Object.entries(completenessKinds).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                评价依据
                <textarea name="note" required maxLength={2000} rows={3} />
              </label>
              <label>
                关联原文链接
                <textarea name="urls" rows={2} />
              </label>
              <button className="solid-button">保存</button>
            </form>
            {reviews.rows.map((r) => (
              <div className="source-review" key={r.id}>
                <p>
                  {taskStamp(r.created_at)} · {verdicts[r.verdict]} ·{' '}
                  {evidenceKinds[r.evidence_kind]} · {completenessKinds[r.completeness]}
                </p>
                <p>{r.note}</p>
                {r.urls.map((url) => (
                  <p key={url}>
                    <a href={url} target="_blank" rel="noreferrer">
                      {url}
                    </a>
                  </p>
                ))}
              </div>
            ))}
          </details>
        </>
      ) : (
        <>
          <nav className="period-options" aria-label="统计周期">
            {[7, 30].map((d) => (
              <Link key={d} href={`?days=${d}`} aria-current={days === d ? 'page' : undefined}>
                近{d}天
              </Link>
            ))}
          </nav>
          <div className="monitor-toolbar">
            <form className="inline-form monitor-filters" aria-label="信源监控筛选">
              <input type="hidden" name="days" value={days} />
              <select name="enabled" aria-label="启用状态" defaultValue={enabledFilter}>
                <option value="enabled">仅启用</option>
                <option value="disabled">仅停用</option>
                <option value="all">全部信源</option>
              </select>
              <select name="status" aria-label="质量状态" defaultValue={statusFilter}>
                <option value="">全部状态</option>
                <option value="abnormal">采集异常</option>
                <option value="cycle_error">本轮采集异常</option>
                <option value="healthy">运行正常</option>
                <option value="zero">日报零采用</option>
              </select>
              <select name="sort" aria-label="排序方式" defaultValue={sort}>
                <option value="order">默认顺序</option>
                <option value="selected">按日报采用</option>
                <option value="discovered">按首次发现</option>
                <option value="relevant">按筛选通过</option>
                <option value="recent">按最近采集</option>
              </select>
              <input
                type="search"
                name="q"
                aria-label="搜索信源"
                placeholder="搜索信源"
                defaultValue={search}
                maxLength={200}
              />
              <button className="solid-button">筛选</button>
            </form>
          </div>
          <div className="monitor-summary">
            <span>启用 {data.metrics.filter((s) => s.enabled).length}</span>
            <span>
              异常或重试{' '}
              {
                data.metrics.filter(
                  (s) => s.enabled && ['failed', 'retry', 'overdue'].includes(s.source_state),
                ).length
              }
            </span>
            <span>
              有采集但零采用{' '}
              {data.metrics.filter((s) => s.enabled && s.discovered > 0 && s.selected === 0).length}
            </span>
            <span>当前显示 {metrics.length}</span>
          </div>
          {overlaps.length > 0 && (
            <section className="monitor-overlap" aria-labelledby="monitor-overlap-title">
              <h2
                id="monitor-overlap-title"
                title="按本周期首次发现且筛选通过的独立事件统计，同一事件的多篇报道只计一次；展示共同覆盖至少3个事件的信源对"
              >
                信源同题覆盖
              </h2>
              <div>
                {overlaps.map((pair) => (
                  <p key={`${pair.left_id}:${pair.right_id}`}>
                    <strong>共同 {pair.shared} 个事件</strong>
                    <span>
                      {pair.left_name} 被 {pair.right_name} 覆盖：{pair.shared}/{pair.left_events}（
                      {percent(pair.shared, pair.left_events)}）
                    </span>
                    <span>
                      {pair.right_name} 被 {pair.left_name} 覆盖：{pair.shared}/{pair.right_events}
                      （{percent(pair.shared, pair.right_events)}）
                    </span>
                  </p>
                ))}
              </div>
            </section>
          )}
          <div
            className="table-wrap source-monitor-table"
            role="region"
            aria-label="信源质量列表"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  {[
                    '信源',
                    '状态',
                    '首次发现',
                    '筛选通过',
                    '筛选通过率',
                    '合格事件',
                    '独家覆盖',
                    '日报采用',
                    '最近采集',
                  ].map((t) => (
                    <th
                      key={t}
                      title={
                        t === '筛选通过率'
                          ? '筛选通过 ÷（通过＋淘汰），不含待处理和失败'
                          : undefined
                      }
                    >
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link href={`?source=${s.id}&days=${days}`}>{s.name}</Link>
                      <details className="source-quality-detail">
                        <summary>质量分析</summary>
                        {s.last_error && <p>{s.last_error}</p>}
                        <dl>
                          <dt>覆盖事件</dt>
                          <dd>{s.events}</dd>
                          <dt>新增事实事件</dt>
                          <dd>{s.incremental}</dd>
                          <dt>最早发现合格事件</dt>
                          <dd>{s.first}</dd>
                          <dt>仅有标题</dt>
                          <dd>{s.title_only}</dd>
                          <dt>处理调用</dt>
                          <dd>{s.calls}</dd>
                          <dt>每个合格事件调用</dt>
                          <dd>{s.qualified ? (s.calls / s.qualified).toFixed(1) : '—'}</dd>
                          <dt>采集成功率</dt>
                          <dd>{percent(s.succeeded_runs, s.succeeded_runs + s.failed_runs)}</dd>
                          <dt>处理失败率</dt>
                          <dd>{percent(s.failed, s.relevant + s.ignored + s.failed)}</dd>
                          <dt>重复抓取旧链接</dt>
                          <dd>
                            {s.repeated_items} / {s.observed_items}
                          </dd>
                        </dl>
                        <Link href={`?source=${s.id}&days=${days}`}>采集明细与人工评价</Link>
                      </details>
                    </td>
                    <td>
                      {
                        (
                          {
                            disabled: '已停用',
                            new: '待首采',
                            failed: '连续失败',
                            retry: '重试中',
                            overdue: '采集逾期',
                            paused: '采集已暂停',
                            healthy: '正常',
                          } as Record<string, string>
                        )[s.source_state]
                      }
                    </td>
                    <td>
                      <Link href={`?source=${s.id}&view=period&days=${days}`}>{s.discovered}</Link>
                    </td>
                    <td>
                      <Link href={`?source=${s.id}&view=period&days=${days}&result=processed`}>
                        {s.relevant}
                      </Link>
                    </td>
                    <td
                      title={`通过 ${s.relevant} / 已完成筛选 ${s.relevant + s.ignored}；不含待处理和失败`}
                    >
                      {percent(s.relevant, s.relevant + s.ignored)}
                    </td>
                    <td>
                      <Link href={`?source=${s.id}&view=period&days=${days}&result=qualified`}>
                        {s.qualified}
                      </Link>
                    </td>
                    <td>
                      <Link href={`?source=${s.id}&view=period&days=${days}&result=exclusive`}>
                        {s.exclusive}
                      </Link>
                    </td>
                    <td>
                      <Link href={`?source=${s.id}&view=period&days=${days}&result=selected`}>
                        {s.selected}
                      </Link>
                    </td>
                    <td>{s.last_fetched_at ? taskStamp(s.last_fetched_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!metrics.length && <p className="empty-state">暂无匹配信源。</p>}
        </>
      )}
    </div>
  );
}
