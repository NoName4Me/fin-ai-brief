import { randomUUID } from 'node:crypto';
import { createMailTransport } from './mail-transport.ts';
import { mailFailure } from './mail-errors.ts';
import { requireMailConfig } from './mail-config.ts';
import { and, eq } from 'drizzle-orm';
import { db } from './db.ts';
import { deliveries, subscriptions } from './schema.ts';
import { publicIndustries, publishedBrief } from './publication.ts';
import { unsubscribeToken } from './subscriptions.ts';
export { escapeHtml, renderEmail } from './mail-template.ts';
import { renderEmail } from './mail-template.ts';
import { kindNames, type Kind } from './types.ts';
export async function deliver(id: string) {
  requireMailConfig();
  const [row] = await db.select().from(deliveries).where(eq(deliveries.id, id));
  if (!row || row.state !== 'pending') return;
  const [recipient] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, row.subscriptionId));
  if (!recipient?.active) {
    await db.delete(deliveries).where(eq(deliveries.id, id));
    return;
  }
  const brief = await publishedBrief(row.briefId);
  if (!brief?.content) throw new Error('正式简报不存在');
  const base = process.env.SITE_URL!;
  const cancelUrl = new URL(
    `/unsubscribe?token=${encodeURIComponent(unsubscribeToken(recipient.id))}`,
    base,
  ).href;
  const claimed = await db
    .update(deliveries)
    .set({ state: 'sending' })
    .where(and(eq(deliveries.id, id), eq(deliveries.state, 'pending')))
    .returning();
  if (!claimed.length) return;
  const transport = createMailTransport();
  try {
    await transport.sendMail({
      from: process.env.MAIL_FROM,
      to: recipient.email,
      subject: `Fin&AI${kindNames[brief.kind as Kind]}｜${brief.content.title}`,
      messageId: `<${row.id}.${randomUUID()}@${new URL(base).hostname}>`,
      html: renderEmail(brief.content, new URL(`/briefs/${brief.id}`, base).href, cancelUrl, {
        kind: brief.kind as Kind,
        date: brief.periodDate,
        issueNumber: brief.issueNumber,
        industries: await publicIndustries(),
      }),
      text: [
        brief.content.title,
        ...Object.values(brief.content.overview),
        ...brief.content.items.map(
          (i) =>
            `${i.title}\n${i.summary}\n${(i.progress ?? []).map((p) => `${p.date}${p.endDate ? `—${p.endDate}` : ''} 报道：${p.text}\n${p.sourceUrls.join('\n')}`).join('\n')}\n${i.sources.map((s) => s.url).join('\n')}`,
        ),
        `取消订阅：${cancelUrl}`,
      ].join('\n\n'),
      headers: { 'List-Unsubscribe': `<${cancelUrl}>` },
    });
    await db
      .update(deliveries)
      .set({ state: 'sent', sentAt: new Date(), error: null })
      .where(eq(deliveries.id, id));
  } catch (error) {
    const failure = mailFailure(error);
    await db.update(deliveries).set(failure).where(eq(deliveries.id, id));
    throw new Error(failure.error);
  } finally {
    transport.close();
  }
}
