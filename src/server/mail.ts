import nodemailer from 'nodemailer';
import { and, eq } from 'drizzle-orm';
import { db } from './db.ts';
import { deliveries, subscriptions } from './schema.ts';
import { publishedBrief } from './publication.ts';
import { unsubscribeToken } from './subscriptions.ts';
import type { BriefContent } from './types.ts';
export const escapeHtml = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function renderEmail(content: BriefContent, issueUrl: string, cancelUrl: string) {
  return `<html lang="zh-CN"><body style="margin:0;background:#f7f5ef;color:#252b30;font:15px/1.9 Songti SC,STSong,SimSun,serif"><table role="presentation" style="max-width:720px;width:100%;margin:auto;padding:28px"><tr><td><p style="color:#233c53;font-size:26px;font-weight:bold">Fin&AI简报</p><h1 style="font-size:24px;color:#233c53;border-bottom:3px double #233c53;padding-bottom:16px">${escapeHtml(content.title)}</h1>${Object.entries(
    content.overview,
  )
    .map(
      ([key, v]) =>
        `<p><strong>${escapeHtml(key === 'finance' ? '金融' : key === 'ai' ? 'AI' : key)}</strong>　${escapeHtml(v)}</p>`,
    )
    .join(
      '',
    )}${content.items.map((item) => `<h2 style="font-size:20px;border-top:1px solid #d7d6cf;padding-top:18px">${escapeHtml(item.title)}</h2><p>${escapeHtml(item.summary)}</p><p style="font-size:13px">${item.sources.map((s) => `<a style="color:#233c53" href="${escapeHtml(s.url)}">${escapeHtml(s.name)}</a>`).join(' / ')}</p>`).join('')}<p style="border-top:3px double #233c53;padding-top:16px;text-align:right">数智化转型办公室·智创组　编制</p><p style="font-size:13px"><a href="${escapeHtml(issueUrl)}">网页阅读</a>　<a href="${escapeHtml(cancelUrl)}">取消订阅</a></p></td></tr></table></body></html>`;
}
export async function deliver(id: string) {
  if (process.env.MAIL_ENABLED !== 'true') throw new Error('正式邮件发送尚未启用');
  if (!process.env.SMTP_HOST || !process.env.MAIL_FROM) throw new Error('请先配置正式发信服务');
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
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
    connectionTimeout: 30_000,
    socketTimeout: 60_000,
  });
  try {
    await transport.sendMail({
      from: process.env.MAIL_FROM,
      to: recipient.email,
      subject: brief.content.title,
      messageId: `<${row.id}@${new URL(base).hostname}>`,
      html: renderEmail(brief.content, new URL(`/briefs/${brief.id}`, base).href, cancelUrl),
      text: [
        brief.content.title,
        ...Object.values(brief.content.overview),
        ...brief.content.items.map(
          (i) => `${i.title}\n${i.summary}\n${i.sources.map((s) => s.url).join('\n')}`,
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
    // SMTP提交后断线无法判断对方是否接受；不自动重发，避免重复邮件。
    await db
      .update(deliveries)
      .set({ state: 'uncertain', error: '发送未确认，请核对发信服务记录' })
      .where(eq(deliveries.id, id));
    throw new Error('邮件发送未确认，请核对发信服务记录');
  } finally {
    transport.close();
  }
}
