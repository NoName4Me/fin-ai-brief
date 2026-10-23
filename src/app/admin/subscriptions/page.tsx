import { requireAdmin } from '../../../server/auth.ts';
import { desc, eq } from 'drizzle-orm';
import { db } from '../../../server/db.ts';
import { subscriptions, deliveries } from '../../../server/schema.ts';
import { kindNames, type Kind } from '../../../server/types.ts';
import { removeSubscriberAction } from '../../actions.ts';
import { Notice, type Query } from '../../../components/notice.tsx';
export default async function Subscriptions({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const [rows, sends] = await Promise.all([
    db.select().from(subscriptions).orderBy(desc(subscriptions.createdAt)).limit(200),
    db
      .select({
        id: deliveries.id,
        state: deliveries.state,
        error: deliveries.error,
        email: subscriptions.email,
      })
      .from(deliveries)
      .innerJoin(subscriptions, eq(deliveries.subscriptionId, subscriptions.id))
      .orderBy(desc(deliveries.createdAt))
      .limit(50),
  ]);
  return (
    <>
      <Notice query={await searchParams} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>邮箱</th>
              <th>订阅类型</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.email}</td>
                <td>{row.kinds.map((k) => kindNames[k as Kind]).join('、')}</td>
                <td>{row.active ? '已登记' : '已退订'}</td>
                <td>
                  <form action={removeSubscriberAction}>
                    <input type="hidden" name="id" value={row.id} />
                    <button className="quiet-button">删除登记</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p className="empty-state">暂无订阅登记。</p>}
      <section className="admin-section">
        <h2>近期发送结果</h2>
        {sends.map((row) => (
          <p key={row.id}>
            {row.email}　
            {
              (
                {
                  pending: '待发送',
                  sending: '发送中',
                  sent: '已发送',
                  failed: '发送失败',
                  uncertain: '结果待确认',
                } as Record<string, string>
              )[row.state]
            }
            　{row.error}
          </p>
        ))}
        {!sends.length && <p className="muted">暂无发送记录。</p>}
      </section>
    </>
  );
}
