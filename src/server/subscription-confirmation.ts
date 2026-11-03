import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull, lt, lte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db.ts';
import { subscriptionConfirmations, subscriptions } from './schema.ts';
import { hash } from './crypto.ts';
import { subscriptionInput, unsubscribeToken } from './subscriptions.ts';
import { requireMailConfig } from './mail-config.ts';
import { createMailTransport } from './mail-transport.ts';
import { renderSubscriptionConfirmation } from './subscription-confirmation-template.ts';

const emailInput = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());

async function sendConfirmationMail(email: string, token: string) {
  const url = new URL('/subscribe/confirm', process.env.SITE_URL!);
  url.searchParams.set('token', token);
  const connection = await requireMailConfig();
  const transport = createMailTransport(connection);
  try {
    await transport.sendMail({
      from: connection.from,
      to: email,
      subject: '《数智参阅》请确认邮箱订阅',
      html: renderSubscriptionConfirmation(url.href),
      text: `确认订阅《数智参阅》\n\n请打开以下链接完成订阅，链接24小时内有效：\n${url.href}\n\n如果不是你本人申请，请忽略此邮件。`,
    });
  } finally {
    transport.close();
  }
}

export async function requestSubscription(input: unknown, now = new Date()) {
  const value = subscriptionInput.parse(input);
  await requireMailConfig();
  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.email, value.email));
  if (existing?.active) return;
  const token = randomBytes(32).toString('base64url');
  const pending = {
    ...value,
    tokenHash: hash(token),
    requestedAt: now,
    expiresAt: new Date(now.getTime() + 24 * 3600_000),
    confirmedAt: null,
  };
  const rows = await db
    .insert(subscriptionConfirmations)
    .values(pending)
    .onConflictDoUpdate({
      target: subscriptionConfirmations.email,
      set: pending,
      setWhere: lt(subscriptionConfirmations.requestedAt, new Date(now.getTime() - 60_000)),
    })
    .returning();
  if (!rows.length) return;
  try {
    await sendConfirmationMail(value.email, token);
  } catch {
    await db
      .delete(subscriptionConfirmations)
      .where(
        and(
          eq(subscriptionConfirmations.email, value.email),
          eq(subscriptionConfirmations.tokenHash, pending.tokenHash),
        ),
      );
    throw new Error('确认邮件发送失败，请稍后重新提交。');
  }
}

export async function resendSubscriptionConfirmation(email: string, now = new Date()) {
  const normalized = emailInput.parse(email);
  await requireMailConfig();
  const [[existing], [confirmation]] = await Promise.all([
    db.select().from(subscriptions).where(eq(subscriptions.email, normalized)),
    db
      .select()
      .from(subscriptionConfirmations)
      .where(eq(subscriptionConfirmations.email, normalized)),
  ]);
  if (existing?.active) throw new Error('该邮箱已订阅，无需发送确认邮件');
  if (!confirmation || confirmation.confirmedAt) throw new Error('未找到待确认或已过期记录');
  const token = randomBytes(32).toString('base64url');
  const pending = {
    tokenHash: hash(token),
    requestedAt: now,
    expiresAt: new Date(now.getTime() + 24 * 3600_000),
    confirmedAt: null,
  };
  await db
    .update(subscriptionConfirmations)
    .set(pending)
    .where(eq(subscriptionConfirmations.email, normalized));
  try {
    await sendConfirmationMail(normalized, token);
  } catch {
    await db
      .update(subscriptionConfirmations)
      .set({
        tokenHash: confirmation.tokenHash,
        requestedAt: confirmation.requestedAt,
        expiresAt: confirmation.expiresAt,
        confirmedAt: confirmation.confirmedAt,
      })
      .where(eq(subscriptionConfirmations.email, normalized));
    throw new Error('确认邮件发送失败，请稍后重试。');
  }
}

export async function deleteExpiredSubscriptionConfirmation(email: string, now = new Date()) {
  const normalized = emailInput.parse(email);
  const rows = await db
    .delete(subscriptionConfirmations)
    .where(
      and(
        eq(subscriptionConfirmations.email, normalized),
        isNull(subscriptionConfirmations.confirmedAt),
        lte(subscriptionConfirmations.expiresAt, now),
      ),
    )
    .returning({ email: subscriptionConfirmations.email });
  if (!rows.length) throw new Error('只能删除已过期的确认记录');
}

export async function confirmSubscription(
  token: string,
  now = new Date(),
): Promise<'success' | 'expired' | 'invalid'> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return 'invalid';
  return db.transaction(async (tx) => {
    const [pending] = await tx
      .select()
      .from(subscriptionConfirmations)
      .where(eq(subscriptionConfirmations.tokenHash, hash(token)))
      .for('update');
    if (!pending) return 'invalid';
    if (pending.expiresAt <= now) return 'expired';
    if (pending.confirmedAt) return 'success';
    const id = randomUUID();
    await tx
      .insert(subscriptions)
      .values({
        id,
        email: pending.email,
        kinds: pending.kinds,
        tokenHash: hash(unsubscribeToken(id)),
        active: true,
        subscribedAt: now,
      })
      .onConflictDoUpdate({
        target: subscriptions.email,
        set: { active: true, kinds: pending.kinds, subscribedAt: now, unsubscribedAt: null },
        setWhere: eq(subscriptions.active, false),
      });
    await tx
      .update(subscriptionConfirmations)
      .set({ confirmedAt: now })
      .where(eq(subscriptionConfirmations.email, pending.email));
    return 'success';
  });
}
