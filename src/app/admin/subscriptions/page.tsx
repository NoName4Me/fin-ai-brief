import { requireAdmin } from '../../../server/auth.ts';
import { desc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../../../server/db.ts';
import { subscriptions, deliveries, briefs } from '../../../server/schema.ts';
import { kindNames, type Kind } from '../../../server/types.ts';
import { addSubscriberAction } from '../../actions.ts';
import { Notice, type Query } from '../../../components/notice.tsx';
import { SubscriptionDelivery } from '../../../components/subscription-delivery.tsx';
import { mailConfigError } from '../../../server/mail-config.ts';
const states: Record<string, string> = {
  pending: '待发送',
  sending: '发送中',
  sent: '已发送',
  failed: '发送失败',
  uncertain: '结果待确认',
};
export default async function Subscriptions({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const [rows, issues, sends] = await Promise.all([
    db.select().from(subscriptions).orderBy(desc(subscriptions.createdAt)),
    db
      .select({
        id: briefs.id,
        kind: briefs.kind,
        periodDate: briefs.periodDate,
        issueNumber: briefs.issueNumber,
        content: briefs.published,
      })
      .from(briefs)
      .where(isNotNull(briefs.published))
      .orderBy(desc(briefs.periodDate)),
    db
      .select({
        id: deliveries.id,
        state: deliveries.state,
        error: deliveries.error,
        email: subscriptions.email,
        kind: briefs.kind,
        periodDate: briefs.periodDate,
        issueNumber: briefs.issueNumber,
        briefId: briefs.id,
      })
      .from(deliveries)
      .innerJoin(subscriptions, eq(deliveries.subscriptionId, subscriptions.id))
      .innerJoin(briefs, eq(deliveries.briefId, briefs.id))
      .orderBy(desc(deliveries.createdAt))
      .limit(50),
  ]);
  return (
    <>
      <Notice query={await searchParams} />
      <SubscriptionDelivery
        key={rows.map((r) => `${r.id}:${r.active}`).join(',')}
        recipients={rows.map((r) => ({
          id: r.id,
          email: r.email,
          active: r.active,
          kinds: r.kinds.map((k) => kindNames[k as Kind]).join('、'),
        }))}
        issues={issues.map((b) => ({
          id: b.id,
          label: `${kindNames[b.kind as Kind]} · ${b.periodDate}${b.issueNumber ? ` · 第${b.issueNumber}期` : ''} · ${b.content!.title}`,
        }))}
        configError={mailConfigError()}
      />
      <details className="admin-section">
        <summary>新增订阅</summary>
        <form action={addSubscriberAction} className="stack-form">
          <label>
            邮箱
            <input name="email" type="email" maxLength={254} required />
          </label>
          <fieldset>
            <legend>订阅类型</legend>
            {Object.entries(kindNames).map(([kind, name]) => (
              <label key={kind} className="check">
                <input
                  type="checkbox"
                  name="kinds"
                  value={kind}
                  defaultChecked={kind === 'daily'}
                />
                {name}
              </label>
            ))}
          </fieldset>
          <button className="outline-button">登记订阅</button>
        </form>
      </details>
      <section className="admin-section">
        <h2>近期发送结果</h2>
        {sends.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>邮箱</th>
                  <th>刊期</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {sends.map((row) => (
                  <tr key={row.id}>
                    <td>{row.email}</td>
                    <td>
                      <a href={`/briefs/${row.briefId}`}>
                        {kindNames[row.kind as Kind]} · {row.periodDate}
                        {row.issueNumber ? ` · 第${row.issueNumber}期` : ''}
                      </a>
                    </td>
                    <td>
                      {states[row.state] ?? row.state}
                      {row.error && <p className="form-hint">{row.error}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">暂无发送记录。</p>
        )}
      </section>
    </>
  );
}
