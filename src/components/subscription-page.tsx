import { desc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../server/db.ts';
import { briefs, deliveries, subscriptionConfirmations, subscriptions } from '../server/schema.ts';
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
  const [rows, confirmations, issues, sends, config] = await Promise.all([
    db.select().from(subscriptions).orderBy(desc(subscriptions.createdAt)),
    db
      .select({
        email: subscriptionConfirmations.email,
        kinds: subscriptionConfirmations.kinds,
        requestedAt: subscriptionConfirmations.requestedAt,
        expiresAt: subscriptionConfirmations.expiresAt,
        confirmedAt: subscriptionConfirmations.confirmedAt,
      })
      .from(subscriptionConfirmations)
      .orderBy(desc(subscriptionConfirmations.requestedAt)),
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
  const now = new Date();
  const recipients = new Map<
    string,
    {
      id: string | null;
      email: string;
      kinds: string;
      status: 'registered' | 'unsubscribed' | 'pending' | 'expired';
      at: Date;
      expiresAt?: Date;
    }
  >();
  for (const row of rows) {
    recipients.set(row.email, {
      id: row.id,
      email: row.email,
      kinds: row.kinds.map((k) => kindNames[k as Kind]).join('、'),
      status: row.active ? 'registered' : 'unsubscribed',
      at: row.unsubscribedAt ?? row.subscribedAt,
    });
  }
  for (const row of confirmations) {
    if (row.confirmedAt) continue;
    const existing = recipients.get(row.email);
    if (existing?.status === 'registered') continue;
    recipients.set(row.email, {
      id: null,
      email: row.email,
      kinds: row.kinds.map((k) => kindNames[k as Kind]).join('、'),
      status: row.expiresAt > now ? 'pending' : 'expired',
      at: row.requestedAt,
      expiresAt: row.expiresAt,
    });
  }
  return (
    <>
      <Notice query={query} />
      <SubscriptionDelivery
        active={active}
        deliveryEnabled={config.deliveryEnabled}
        configError={mailConfigError()}
        recipients={[...recipients.values()]
          .sort((a, b) => b.at.getTime() - a.at.getTime())
          .map((row) => ({
            ...row,
            at: taskStamp(row.at),
            expiresAt: row.expiresAt ? taskStamp(row.expiresAt) : undefined,
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
