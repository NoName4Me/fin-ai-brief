import { sql } from 'drizzle-orm';
import type { db } from './db.ts';
// 与发布同一事务落库；不会因稍后开启发信而补发历史简报。
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function createDeliveries(tx: Transaction, briefId: string, kind: string) {
  if (process.env.MAIL_ENABLED !== 'true') return;
  await tx.execute(sql`INSERT INTO deliveries(brief_id,subscription_id)
    SELECT ${briefId}::uuid,id FROM subscriptions
    WHERE active=true AND kinds @> ${JSON.stringify([kind])}::jsonb
    ON CONFLICT(brief_id,subscription_id) DO NOTHING`);
}
