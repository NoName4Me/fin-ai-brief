import { syncMailSettings } from './mail-settings-fixture.ts';
import { test, before, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { closeMailTransports } from '../src/server/mail-sender.ts';
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
  closeMailTransports();
  mock.restoreAll();
  await pool.query('TRUNCATE mail_send_runtime, deliveries, subscriptions, briefs CASCADE');
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
  await syncMailSettings();
});
after(async () => {
  closeMailTransports();
  mock.restoreAll();
  await pool.end();
});
for (const scenario of [
  {
    name: 'TLS连接未建立',
    code: 'ETLS',
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
  {
    name: '提交结果不明且底层仅报告CONN',
    code: 'ECONNECTION',
    command: 'CONN',
    message: 'Connection closed unexpectedly',
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
  assert.equal(subject, `《数智参阅》第005期｜${fixtureContent().title}`);
  assert.ok(html.includes('第005期'));
  assert.ok(html.includes('金融要情'));
  assert.ok(!html.includes('>总览<'));
  assert.ok(html.includes('padding:28px 28px;'));
  assert.ok(html.includes('max-width:960px;'));
  assert.ok(!html.includes('<td class="email-calendar"'));
  assert.ok(html.includes('主办：数智化转型办公室 智创组'));
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

test('连续投递复用同一SMTP连接池，不逐封关闭或重新认证', async () => {
  let created = 0;
  let closed = 0;
  let sent = 0;
  const started: number[] = [];
  mock.method(nodemailer, 'createTransport', (options: unknown) => {
    assert.equal((options as { pool: boolean }).pool, true);
    assert.equal((options as { maxConnections: number }).maxConnections, 1);
    assert.equal((options as { maxRequeues: number }).maxRequeues, 0);
    created++;
    return {
      sendMail: async () => {
        started.push(Date.now());
        sent++;
        return {};
      },
      close: () => {
        closed++;
      },
    };
  });
  const [first] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  await subscribe({ email: 'second@example.invalid', kinds: ['daily'] });
  const [second] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.email, 'second@example.invalid'));
  const [next] = await db
    .insert(deliveries)
    .values({ briefId: first.briefId, subscriptionId: second.id })
    .returning();
  await Promise.all([deliver(deliveryId), deliver(next.id)]);
  assert.equal(sent, 2);
  assert.equal(created, 1);
  assert.equal(closed, 0);
  assert.ok(started[1] - started[0] >= 4_950, '两封邮件至少间隔5秒');
});

test('认证失败持久化冷却，其他投递保持待发送；重建连接池也不绕过冷却，到期只继续未发送邮件', async () => {
  let attempts = 0;
  mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async () => {
      attempts++;
      if (attempts === 1)
        throw Object.assign(new Error('535 Login fail'), {
          code: 'EAUTH',
          command: 'AUTH PLAIN',
          responseCode: 535,
        });
      return {};
    },
    close: () => {},
  }));
  await assert.rejects(deliver(deliveryId), /EAUTH/);
  const [first] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  await subscribe({ email: 'waiting@example.invalid', kinds: ['daily'] });
  const [recipient] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.email, 'waiting@example.invalid'));
  const [waiting] = await db
    .insert(deliveries)
    .values({ briefId: first.briefId, subscriptionId: recipient.id })
    .returning();
  const {
    rows: [runtime],
  } = await pool.query(
    "SELECT cooldown_until > clock_timestamp() + interval '14 minutes' AS cooling FROM mail_send_runtime",
  );
  assert.equal(runtime.cooling, true);
  closeMailTransports();
  await deliver(waiting.id);
  let [row] = await db.select().from(deliveries).where(eq(deliveries.id, waiting.id));
  assert.equal(row.state, 'pending');
  assert.match(row.error!, /SMTP认证冷却/);
  assert.equal(row.sentAt, null);
  assert.equal(attempts, 1);
  await pool.query(
    "UPDATE mail_send_runtime SET cooldown_until=clock_timestamp()-interval '1 second',next_send_at=clock_timestamp()",
  );
  await deliver(waiting.id);
  [row] = await db.select().from(deliveries).where(eq(deliveries.id, waiting.id));
  assert.equal(row.state, 'sent');
  assert.equal(row.error, null);
  assert.equal(attempts, 2);
  await deliver(deliveryId);
  assert.equal(attempts, 2, '此前明确失败的邮件仍需手动重排');
});

test('并发投递同一记录仍只发送一次', async () => {
  let sent = 0;
  mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async () => {
      sent++;
      return {};
    },
    close: () => {},
  }));
  await Promise.all([deliver(deliveryId), deliver(deliveryId)]);
  assert.equal(sent, 1);
});
