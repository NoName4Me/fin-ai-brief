import { desc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../server/db.ts';
import { briefs, deliveries, subscriptions } from '../server/schema.ts';
import { getSettings } from '../server/settings.ts';
import { kindNames, type Kind } from '../server/types.ts';
import { taskStamp } from '../server/task-labels.ts';
import { mailConfigError } from '../server/mail-config.ts';
import { cleanBriefTitle } from '../server/brief-title.ts';
import { SubscriptionDelivery } from './subscription-delivery.tsx';
import { Notice, type Query } from './notice.tsx';
export async function SubscriptionPage({
  active,
  query,
}: {
  active: 'subscribers' | 'history';
  query: Query;
}) {
  const [rows, issues, sends, config] = await Promise.all([
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
    active === 'history'
      ? db
          .select({
            id: deliveries.id,
            state: deliveries.state,
            error: deliveries.error,
            email: subscriptions.email,
            kind: briefs.kind,
            periodDate: briefs.periodDate,
            issueNumber: briefs.issueNumber,
            briefId: briefs.id,
            createdAt: deliveries.createdAt,
          })
          .from(deliveries)
          .innerJoin(subscriptions, eq(deliveries.subscriptionId, subscriptions.id))
          .innerJoin(briefs, eq(deliveries.briefId, briefs.id))
          .orderBy(desc(deliveries.createdAt))
          .limit(50)
      : Promise.resolve([]),
    getSettings(),
  ]);
  return (
    <>
      <Notice query={query} />
      <SubscriptionDelivery
        active={active}
        deliveryEnabled={config.deliveryEnabled}
        configError={mailConfigError()}
        recipients={rows.map((r) => ({
          id: r.id,
          email: r.email,
          active: r.active,
          kinds: r.kinds.map((k) => kindNames[k as Kind]).join('、'),
          createdAt: taskStamp(r.createdAt),
        }))}
        issues={issues.map((b) => ({
          id: b.id,
          label: `${b.periodDate}${b.issueNumber ? ` · 第${b.issueNumber}期` : ''} · ${cleanBriefTitle(b.content!.title)}`,
        }))}
        sends={sends.map((r) => ({
          ...r,
          issue: `${kindNames[r.kind as Kind]} · ${r.periodDate}${r.issueNumber ? ` · 第${r.issueNumber}期` : ''}`,
          createdAt: taskStamp(r.createdAt),
        }))}
      />
    </>
  );
}
