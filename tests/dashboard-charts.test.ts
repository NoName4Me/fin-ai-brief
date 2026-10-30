import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/server/db.ts';
import { sourceOverlap } from '../src/server/source-metrics.ts';
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

test('重复轮询旧链接不进入待评估信源，新增较多而零采用才进入', async () => {
  const source = (
    await pool.query(
      "INSERT INTO sources(name,url,format,industry_id,enabled) VALUES('稳定源','https://example.invalid/feed','json','ai',true) RETURNING id",
    )
  ).rows[0].id;
  const run = (
    await pool.query(
      "INSERT INTO collection_runs(source_id,source_name,url,state) VALUES($1,'稳定源','https://example.invalid','succeeded') RETURNING id",
      [source],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO collection_items(run_id,source_id,title,url,outcome)
    SELECT $1,$2,'旧资讯','https://example.invalid/old','repeated' FROM generate_series(1,100)`,
    [run, source],
  );
  let result = await dashboardCharts(7);
  assert.equal(result.lowEfficiency.length, 0);
  await pool.query(
    `INSERT INTO source_discoveries(source_id,url,title)
    SELECT $1,'https://example.invalid/new/'||n,'新资讯' FROM generate_series(1,10) n`,
    [source],
  );
  result = await dashboardCharts(7);
  assert.deepEqual(
    result.lowEfficiency.map((s) => s.id),
    [source],
  );
});

test('跨信源同题覆盖按独立事件去重，双方保留各自分母', async () => {
  const sources = (
    await pool.query(
      "INSERT INTO sources(name,format,industry_id) VALUES('小信源','manual','ai'),('大信源','manual','ai') RETURNING id,name",
    )
  ).rows;
  const small = sources.find((s) => s.name === '小信源')!.id;
  const large = sources.find((s) => s.name === '大信源')!.id;
  for (let i = 0; i < 6; i++) {
    const event = (
      await pool.query(
        "INSERT INTO events(industry_id,title,summary,section,score,occurred_at) VALUES('ai','事件','摘要','工具与开源',80,now()) RETURNING id",
      )
    ).rows[0].id;
    for (const source of i < 3 ? [small, large] : [large]) {
      // 同源多篇报道、重复观察都不能放大事件数。
      for (let n = 0; n < 2; n++) {
        const url = `https://example.invalid/${source}/${i}/${n}`;
        await pool.query(
          `INSERT INTO articles(source_id,source_name,industry_id,url,title,excerpt,published_at,state,event_id)
          VALUES($1,'测试源','ai',$2,'资讯','摘要',now(),'processed',$3)`,
          [source, url, event],
        );
        await pool.query(
          "INSERT INTO source_discoveries(source_id,url,title) VALUES($1,$2,'资讯')",
          [source, url],
        );
      }
    }
  }
  const pairs = await sourceOverlap(7);
  assert.equal(pairs.length, 1);
  const pair = pairs[0];
  assert.equal(pair.shared, 3);
  const counts = new Map([
    [pair.left_id, pair.left_events],
    [pair.right_id, pair.right_events],
  ]);
  assert.equal(counts.get(small), 3);
  assert.equal(counts.get(large), 6);
  assert.equal(pair.shared / counts.get(small)!, 1);
  assert.equal(pair.shared / counts.get(large)!, 0.5);
});
