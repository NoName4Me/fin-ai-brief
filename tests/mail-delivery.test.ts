import { test, before, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/server/db.ts';
import { briefs, subscriptions, deliveries } from '../src/server/schema.ts';
import { migrate } from '../scripts/migrate.ts';
import { fixtureContent } from './fixtures.ts';
import { subscribe } from '../src/server/subscriptions.ts';
import { deliver } from '../src/server/mail.ts';
import { requestManualDelivery } from '../src/server/manual-delivery.ts';
if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('测试必须连接独立 _test 数据库');
let deliveryId: string;
before(async () => {
  await migrate();
});
beforeEach(async () => {
  mock.restoreAll();
  await pool.query('TRUNCATE deliveries, subscriptions, briefs CASCADE');
  Object.assign(process.env, {
    MAIL_ENABLED: 'true',
    SMTP_HOST: 'smtp.example.invalid',
    SMTP_PORT: '465',
    SMTP_SECURE: 'true',
    SMTP_USER: 'sender@example.invalid',
    SMTP_PASSWORD: 'test-only-password',
    MAIL_FROM: 'sender@example.invalid',
    SITE_URL: 'https://brief.example.invalid',
    APP_SECRET: 'mail-delivery-regression-test-secret-32',
  });
  const briefId = randomUUID();
  await db
    .insert(briefs)
    .values({ id: briefId, kind: 'daily', periodDate: '2026-10-22', published: fixtureContent() });
  await subscribe({ email: 'reader@example.invalid', kinds: ['daily'] });
  const [recipient] = await db.select().from(subscriptions);
  const [delivery] = await db
    .insert(deliveries)
    .values({ briefId, subscriptionId: recipient.id })
    .returning();
  deliveryId = delivery.id;
});
after(async () => {
  mock.restoreAll();
  await pool.end();
});
for (const scenario of [
  {
    name: 'TLS连接未建立',
    code: 'ESOCKET',
    command: 'CONN',
    message: 'TLS connection disconnected',
    expected: 'failed',
  },
  {
    name: '账号认证被拒',
    code: 'EAUTH',
    command: 'AUTH PLAIN',
    message: 'Invalid login',
    responseCode: 535,
    expected: 'failed',
  },
  {
    name: '服务器明确拒收正文',
    code: 'EMESSAGE',
    command: 'DATA',
    message: 'Message rejected',
    responseCode: 550,
    expected: 'failed',
  },
  {
    name: '提交正文后断线',
    code: 'ECONNECTION',
    command: 'DATA',
    message: 'Connection lost',
    expected: 'uncertain',
  },
])
  test(`${scenario.name}保留正确状态和具体原因，且不重复发送`, async () => {
    let calls = 0;
    let closed = false;
    mock.method(nodemailer, 'createTransport', () => ({
      sendMail: async () => {
        calls++;
        throw Object.assign(new Error(scenario.message), scenario);
      },
      close: () => {
        closed = true;
      },
    }));
    await assert.rejects(deliver(deliveryId), new RegExp(scenario.code));
    const [row] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
    assert.equal(row.state, scenario.expected);
    assert.ok(row.error?.includes(scenario.message));
    assert.equal(row.sentAt, null);
    assert.ok(closed);
    await deliver(deliveryId);
    assert.equal(calls, 1);
  });
test('投递错误不暴露密码、认证编码和邮箱地址', async () => {
  mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async () => {
      throw Object.assign(
        new Error(
          `Auth ${process.env.SMTP_PASSWORD} ${Buffer.from(process.env.SMTP_PASSWORD!).toString('base64')} sender@example.invalid reader@example.invalid`,
        ),
        { code: 'EAUTH', command: 'AUTH PLAIN' },
      );
    },
    close: () => {},
  }));
  await assert.rejects(deliver(deliveryId));
  const [row] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  assert.ok(row.error?.includes('EAUTH'));
  assert.ok(!row.error?.includes(process.env.SMTP_PASSWORD!));
  assert.ok(!row.error?.includes('example.invalid'));
  assert.ok(!row.error?.includes(Buffer.from(process.env.SMTP_PASSWORD!).toString('base64')));
});

test('实际发送使用新版模板并带入已发布刊期元数据', async () => {
  const [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  await db.update(briefs).set({ issueNumber: 5 }).where(eq(briefs.id, delivery.briefId));
  let html = '';
  let subject = '';
  mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async (message: { html: string; subject: string }) => {
      html = message.html;
      subject = message.subject;
      return {};
    },
    close: () => {},
  }));
  await deliver(deliveryId);
  assert.equal(subject, `AI日报｜${fixtureContent().title}`);
  assert.ok(html.includes('第005期'));
  assert.ok(html.includes('金融要情'));
  assert.ok(!html.includes('>总览<'));
  assert.ok(html.includes('padding:28px 28px;'));
  assert.ok(html.includes('max-width:1040px;'));
  assert.ok(html.includes('email-calendar'));
  assert.equal(
    (await db.select().from(deliveries).where(eq(deliveries.id, deliveryId)))[0].state,
    'sent',
  );
});

test('强制重发实际调用发送流程并使用新的Message-ID', async () => {
  const messageIds: string[] = [];
  mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async (message: { messageId: string }) => {
      messageIds.push(message.messageId);
      return {};
    },
    close: () => {},
  }));
  await deliver(deliveryId);
  const [row] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  await requestManualDelivery({
    briefId: row.briefId,
    subscriptionIds: [row.subscriptionId],
    force: true,
  });
  await deliver(deliveryId);
  assert.equal(messageIds.length, 2);
  assert.notEqual(messageIds[0], messageIds[1]);
  assert.equal(
    (await db.select().from(deliveries).where(eq(deliveries.id, deliveryId)))[0].state,
    'sent',
  );
});
