import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db.ts';
import { briefs, deliveries, subscriptions } from './schema.ts';
import { requireMailConfig } from './mail-config.ts';

const inputSchema = z.object({
  briefId: z.uuid(),
  force: z.boolean().default(false),
  subscriptionIds: z.array(z.uuid()).min(1).max(200),
});

export async function requestManualDelivery(input: unknown) {
  const value = inputSchema.parse(input);
  requireMailConfig();
  const ids = [...new Set(value.subscriptionIds)];
  return db.transaction(async (tx) => {
    const [brief] = await tx
      .select({ id: briefs.id })
      .from(briefs)
      .where(and(eq(briefs.id, value.briefId), isNotNull(briefs.published)))
      .for('share');
    if (!brief) throw new Error('请选择已发布的刊期');
    const recipients = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(inArray(subscriptions.id, ids), eq(subscriptions.active, true)))
      .for('share');
    if (recipients.length !== ids.length) throw new Error('部分邮箱已退订或删除，请刷新后重新选择');
    // 强制推送只重排终态记录；条件更新确保并发点击不会重复入队。
    const created = await tx
      .insert(deliveries)
      .values(recipients.map((recipient) => ({ briefId: brief.id, subscriptionId: recipient.id })))
      .onConflictDoUpdate({
        target: [deliveries.briefId, deliveries.subscriptionId],
        set: { state: 'pending', error: null, sentAt: null, createdAt: new Date() },
        setWhere: inArray(
          deliveries.state,
          value.force ? ['failed', 'sent', 'uncertain'] : ['failed'],
        ),
      })
      .returning({ id: deliveries.id });
    return { created: created.length, skipped: ids.length - created.length };
  });
}
