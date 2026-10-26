import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/server/db.ts';
import { briefs, deliveries, subscriptions } from '../src/server/schema.ts';
import { migrate } from '../scripts/migrate.ts';
import { fixtureContent } from './fixtures.ts';
import { subscribe, unsubscribe } from '../src/server/subscriptions.ts';
import { requestManualDelivery } from '../src/server/manual-delivery.ts';
import { createDeliveries } from '../src/server/delivery-outbox.ts';

if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('测试必须连接独立 _test 数据库');
let briefId: string;
before(async () => {
  await migrate();
});
beforeEach(async () => {
  await pool.query('TRUNCATE deliveries, subscriptions, briefs CASCADE');
  process.env.MAIL_ENABLED = 'true';
  process.env.SMTP_HOST = 'smtp.example.invalid';
  process.env.SMTP_PORT = '465';
  process.env.SMTP_SECURE = 'true';
  process.env.SMTP_USER = 'sender@example.invalid';
  process.env.SMTP_PASSWORD = 'test-only';
  process.env.MAIL_FROM = 'sender@example.invalid';
  process.env.APP_SECRET = 'test-only-32-character-secret-for-mail';
  process.env.SITE_URL = 'https://brief.example.invalid';
  briefId = randomUUID();
  await db
    .insert(briefs)
    .values({ id: briefId, kind: 'daily', periodDate: '2026-10-22', published: fixtureContent() });
});
after(async () => {
  await pool.end();
});
async function recipient(email: string, kinds = ['daily']) {
  const token = await subscribe({ email, kinds });
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.email, email));
  return { id: row.id, token: token! };
}
test('手动给多个邮箱推送历史刊期，不改变其订阅类型；并发重复提交只创建一次', async () => {
  const a = await recipient('one@example.invalid');
  const b = await recipient('two@example.invalid', ['monthly']);
  const input = { briefId, subscriptionIds: [a.id, b.id, a.id] };
  const results = await Promise.all([requestManualDelivery(input), requestManualDelivery(input)]);
  assert.equal(
    results.reduce((n, r) => n + r.created, 0),
    2,
  );
  assert.equal(
    results.reduce((n, r) => n + r.skipped, 0),
    2,
  );
  const rows = await db.select().from(deliveries);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.state === 'pending' && r.briefId === briefId));
  assert.deepEqual(
    (await db.select().from(subscriptions).where(eq(subscriptions.id, b.id)))[0].kinds,
    ['monthly'],
  );
});
test('退订或不存在的邮箱使整批操作失败；草稿不可发送', async () => {
  const a = await recipient('one@example.invalid');
  const b = await recipient('two@example.invalid');
  await unsubscribe(b.token);
  for (const id of [b.id, randomUUID()])
    await assert.rejects(
      requestManualDelivery({ briefId, subscriptionIds: [a.id, id] }),
      /退订或删除/,
    );
  await db
    .update(briefs)
    .set({ published: null, draft: fixtureContent() })
    .where(eq(briefs.id, briefId));
  await assert.rejects(requestManualDelivery({ briefId, subscriptionIds: [a.id] }), /已发布/);
  assert.equal((await db.select().from(deliveries)).length, 0);
});
test('发信未开启或配置不全不会入队', async () => {
  const a = await recipient('one@example.invalid');
  const input = { briefId, subscriptionIds: [a.id] };
  process.env.MAIL_ENABLED = 'false';
  await assert.rejects(requestManualDelivery(input), /尚未启用/);
  process.env.MAIL_ENABLED = 'true';
  process.env.SMTP_HOST = '';
  await assert.rejects(requestManualDelivery(input), /SMTP_HOST/);
  process.env.SMTP_HOST = 'https://cmail.example.invalid';
  await assert.rejects(requestManualDelivery(input), /域名/);
  assert.equal((await db.select().from(deliveries)).length, 0);
});
test('手动与自动投递共用去重，不重复发送已发送或结果不明的邮件', async () => {
  const a = await recipient('one@example.invalid');
  await db.transaction((tx) => createDeliveries(tx, briefId, 'daily'));
  for (const state of ['pending', 'sending', 'sent', 'uncertain']) {
    await db.update(deliveries).set({ state });
    assert.deepEqual(await requestManualDelivery({ briefId, subscriptionIds: [a.id] }), {
      created: 0,
      skipped: 1,
    });
  }
  assert.equal((await db.select().from(deliveries)).length, 1);
});

test('失败投递允许手动重新推送，并发提交只重新排队一次，自动发布不重试', async () => {
  const a = await recipient('one@example.invalid');
  const input = { briefId, subscriptionIds: [a.id] };
  await requestManualDelivery(input);
  await db.update(deliveries).set({ state: 'failed', error: '旧连接失败' });
  await db.transaction((tx) => createDeliveries(tx, briefId, 'daily'));
  assert.equal((await db.select().from(deliveries))[0].state, 'failed');
  const results = await Promise.all([requestManualDelivery(input), requestManualDelivery(input)]);
  assert.equal(
    results.reduce((n, r) => n + r.created, 0),
    1,
  );
  assert.equal(
    results.reduce((n, r) => n + r.skipped, 0),
    1,
  );
  const rows = await db.select().from(deliveries);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'pending');
  assert.equal(rows[0].error, null);
  assert.equal(rows[0].sentAt, null);
});

test('强制推送可重发已发送和结果待确认记录，关闭时保留去重', async () => {
  const a = await recipient('one@example.invalid');
  const input = { briefId, subscriptionIds: [a.id] };
  await requestManualDelivery(input);
  for (const state of ['sent', 'uncertain']) {
    await db.update(deliveries).set({ state, sentAt: new Date(), error: '旧记录' });
    assert.deepEqual(await requestManualDelivery({ ...input, force: false }), {
      created: 0,
      skipped: 1,
    });
    assert.deepEqual(await requestManualDelivery({ ...input, force: true }), {
      created: 1,
      skipped: 0,
    });
    const [row] = await db.select().from(deliveries);
    assert.equal(row.state, 'pending');
    assert.equal(row.sentAt, null);
    assert.equal(row.error, null);
  }
});
test('强制推送仍跳过排队中和发送中记录，连续并发提交只重排一次', async () => {
  const a = await recipient('one@example.invalid');
  const input = { briefId, subscriptionIds: [a.id], force: true };
  await requestManualDelivery(input);
  for (const state of ['pending', 'sending']) {
    await db.update(deliveries).set({ state });
    assert.deepEqual(await requestManualDelivery(input), { created: 0, skipped: 1 });
  }
  await db.update(deliveries).set({ state: 'sent' });
  const results = await Promise.all([requestManualDelivery(input), requestManualDelivery(input)]);
  assert.equal(
    results.reduce((n, r) => n + r.created, 0),
    1,
  );
  assert.equal(
    results.reduce((n, r) => n + r.skipped, 0),
    1,
  );
});
