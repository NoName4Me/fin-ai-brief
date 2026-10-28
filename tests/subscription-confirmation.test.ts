import { test, before, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { pool } from '../src/server/db.ts';
import { migrate } from '../scripts/migrate.ts';
import {
  requestSubscription,
  confirmSubscription,
} from '../src/server/subscription-confirmation.ts';
import { subscribe, unsubscribe } from '../src/server/subscriptions.ts';
if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('测试必须连接独立_test数据库');
let messages: { text: string; html: string; subject: string }[];
const now = new Date('2026-10-28T06:00:00Z');
const input = { email: 'reader@example.invalid', kinds: ['daily'] };
function token() {
  return new URL(messages.at(-1)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
}
before(migrate);
beforeEach(async () => {
  mock.restoreAll();
  await pool.query('TRUNCATE subscription_confirmations,subscriptions CASCADE');
  Object.assign(process.env, {
    MAIL_ENABLED: 'true',
    SMTP_HOST: 'smtp.example.invalid',
    MAIL_FROM: '数智参阅 <sender@example.invalid>',
    SITE_URL: 'https://brief.example.invalid',
    APP_SECRET: 'test-secret-long-enough-for-confirmation-tokens',
    SMTP_USER: '',
    SMTP_PASSWORD: '',
  });
  messages = [];
  mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async (message: (typeof messages)[number]) => {
      messages.push(message);
    },
    close: () => {},
  }));
});
after(async () => {
  mock.restoreAll();
  await pool.end();
});
test('用户端先发确认信，确认前不订阅，确认后生效且重复点击不复活退订', async () => {
  await requestSubscription(input, now);
  assert.equal((await pool.query('select * from subscriptions')).rowCount, 0);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].html.includes('确认订阅'));
  assert.ok(messages[0].html.includes('浏览器地址栏'));
  assert.ok(messages[0].html.includes('24小时'));
  const key = token();
  assert.equal(await confirmSubscription(key, new Date(now.getTime() + 1000)), 'success');
  const row = (await pool.query('select * from subscriptions')).rows[0];
  assert.equal(row.active, true);
  assert.equal(messages.length, 1, '不另发成功邮件');
  const { unsubscribeToken } = await import('../src/server/subscriptions.ts');
  await unsubscribe(unsubscribeToken(row.id));
  assert.equal(await confirmSubscription(key, new Date(now.getTime() + 2000)), 'success');
  assert.equal((await pool.query('select active from subscriptions')).rows[0].active, false);
});
test('24小时到期拒绝确认，新申请替换旧链接，发送冷却期不重复发信', async () => {
  await requestSubscription(input, now);
  const old = token();
  await requestSubscription(input, new Date(now.getTime() + 1000));
  assert.equal(messages.length, 1);
  assert.equal(await confirmSubscription(old, new Date(now.getTime() + 24 * 3600_000)), 'expired');
  await requestSubscription(input, new Date(now.getTime() + 24 * 3600_000));
  assert.equal(messages.length, 2);
  assert.equal(await confirmSubscription(old, now), 'invalid');
  assert.equal(
    await confirmSubscription(token(), new Date(now.getTime() + 24 * 3600_000 + 1)),
    'success',
  );
});
test('管理员登记立即生效，无需确认或发信', async () => {
  await subscribe(input);
  assert.equal((await pool.query('select active from subscriptions')).rows[0].active, true);
  assert.equal(messages.length, 0);
});
test('发送失败不产生订阅，并允许重新申请', async () => {
  mock.restoreAll();
  mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async () => {
      throw new Error('smtp failure');
    },
    close: () => {},
  }));
  await assert.rejects(requestSubscription(input, now), /确认邮件发送失败/);
  assert.equal((await pool.query('select * from subscriptions')).rowCount, 0);
  assert.equal((await pool.query('select * from subscription_confirmations')).rowCount, 0);
  assert.equal(await confirmSubscription('wrong', now), 'invalid');
});
