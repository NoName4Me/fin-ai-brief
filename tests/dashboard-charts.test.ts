import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/server/db.ts';
import { migrate } from '../scripts/migrate.ts';
import { dashboardCharts, dashboardRange } from '../src/server/dashboard-charts.ts';

if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('看板测试必须连接独立 _test 库');

before(async () => migrate());
beforeEach(async () => {
  await pool.query(
    'TRUNCATE subscriptions,source_discoveries,collection_runs,articles,events,sources,edition_runs,model_calls CASCADE',
  );
});
after(async () => pool.end());

test('周期看板按自然日统计，订阅新增、取消和历史总量可还原', async () => {
  const range = dashboardRange(7, new Date('2026-10-29T04:00:00Z'));
  assert.equal(range.start.toISOString(), '2026-10-22T16:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-10-29T16:00:00.000Z');
  for (const [email, subscribedAt, unsubscribedAt] of [
    ['one@example.com', '2026-10-23T01:00:00Z', null],
    ['two@example.com', '2026-10-25T01:00:00Z', '2026-10-26T01:00:00Z'],
  ]) {
    await pool.query(
      `INSERT INTO subscriptions(id,email,kinds,token_hash,active,subscribed_at,unsubscribed_at)
      VALUES($1,$2,'["daily"]',$3,$4,$5,$6)`,
      [randomUUID(), email, randomUUID(), !unsubscribedAt, subscribedAt, unsubscribedAt],
    );
  }
  const data = await dashboardCharts(7, new Date('2026-10-29T04:00:00Z'));
  assert.equal(data.subscriptions.start, 0);
  assert.equal(data.subscriptions.added, 2);
  assert.equal(data.subscriptions.cancelled, 1);
  assert.equal(data.subscriptions.net, 1);
  assert.equal(data.subscriptions.current, 1);
  assert.deepEqual(
    data.subscriptions.trend
      .filter((day) => ['2026-10-23', '2026-10-25', '2026-10-26'].includes(day.date))
      .map((day) => [day.date, day.total]),
    [
      ['2026-10-23', 1],
      ['2026-10-25', 2],
      ['2026-10-26', 1],
    ],
  );
  assert.equal(data.trend.length, 7);
  assert.equal(data.summary.incoming, 0);
});
