import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from './db.ts';
import { subscriptions } from './schema.ts';
import { hash } from './crypto.ts';
import { kindSchema } from './types.ts';
export function unsubscribeToken(id: string) {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 32) throw new Error('APP_SECRET 需要至少32位随机字符串');
  return `${id}.${createHmac('sha256', secret).update(id).digest('base64url')}`;
}
export const subscriptionInput = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  kinds: z.array(kindSchema).min(1).max(3),
});
export async function subscribe(input: unknown) {
  const value = subscriptionInput.parse(input);
  const id = randomUUID();
  const token = unsubscribeToken(id);
  const rows = await db
    .insert(subscriptions)
    .values({ ...value, id, tokenHash: hash(token) })
    .onConflictDoNothing({ target: subscriptions.email })
    .returning({ id: subscriptions.id });
  // 重复登记不泄露原有退订凭据，也不改动原有偏好。
  return rows.length ? token : null;
}
export async function unsubscribe(token: string) {
  if (token.length > 150) throw new Error('退订链接无效');
  const rows = await db
    .update(subscriptions)
    .set({ active: false })
    .where(eq(subscriptions.tokenHash, hash(token)))
    .returning({ id: subscriptions.id });
  if (!rows.length) throw new Error('退订链接无效');
}
export async function removeSubscription(id: string) {
  await db.delete(subscriptions).where(eq(subscriptions.id, id));
}
