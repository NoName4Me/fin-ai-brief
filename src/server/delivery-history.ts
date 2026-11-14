import { count, desc, eq } from 'drizzle-orm';
import { db } from './db.ts';
import { briefs, deliveries, subscriptions } from './schema.ts';

export async function deliveryHistory(requestedPage: unknown = 1) {
  const pageSize = 50;
  const [{ total }] = await db
    .select({ total: count() })
    .from(deliveries)
    .innerJoin(subscriptions, eq(deliveries.subscriptionId, subscriptions.id))
    .innerJoin(briefs, eq(deliveries.briefId, briefs.id));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const parsed =
    typeof requestedPage === 'string' || typeof requestedPage === 'number'
      ? Number(requestedPage)
      : 1;
  const page = Number.isSafeInteger(parsed) ? Math.min(pages, Math.max(1, parsed)) : 1;
  const items = await db
    .select({
      id: deliveries.id,
      state: deliveries.state,
      error: deliveries.error,
      email: subscriptions.email,
      recipientActive: subscriptions.active,
      kind: briefs.kind,
      periodDate: briefs.periodDate,
      issueNumber: briefs.issueNumber,
      briefId: briefs.id,
      createdAt: deliveries.createdAt,
    })
    .from(deliveries)
    .innerJoin(subscriptions, eq(deliveries.subscriptionId, subscriptions.id))
    .innerJoin(briefs, eq(deliveries.briefId, briefs.id))
    .orderBy(desc(deliveries.createdAt), desc(deliveries.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { items, total, page, pages };
}
