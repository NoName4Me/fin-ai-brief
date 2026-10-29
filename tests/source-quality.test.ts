import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/server/db.ts';
import { migrate } from '../scripts/migrate.ts';
import { collectSource } from '../src/server/collect.ts';
import { sourceQualityData, discoveryRange } from '../src/server/source-metrics.ts';
import { saveSettings } from '../src/server/settings.ts';
import { defaultSettings } from '../src/server/types.ts';
if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('须使用独立_test库');
before(async () => {
  await migrate();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE sources,articles,events,collection_runs,briefs,processing_steps,model_calls CASCADE',
  );
  await saveSettings({ ...defaultSettings, collectionEnabled: true });
});
after(async () => {
  await pool.end();
});
const now = new Date('2026-10-29T04:00:00Z');
const item = {
  title: 'AI工具公布更新',
  url: 'https://example.invalid/shared',
  excerpt: '正式公布工具及使用条件。',
  publishedAt: '2026-10-29T01:00:00Z',
};
async function source(name: string) {
  return (
    await pool.query(
      "INSERT INTO sources(name,url,format,industry_id,enabled) VALUES($1,'https://example.invalid/feed/'||$1,'json','ai',true) RETURNING id",
      [name],
    )
  ).rows[0].id as string;
}
async function collect(id: string, entries: unknown[], time = now) {
  return collectSource(id, async () => JSON.stringify(entries), time);
}
test('先记录各信源发现关系再全局去重，轮询不放大首次发现数', async () => {
  const a = await source('A'),
    b = await source('B');
  assert.equal((await collect(a, [{ ...item, url: item.url + '?utm_source=a#top' }])).inserted, 1);
  assert.equal((await collect(a, [item], new Date(now.getTime() + 1000))).inserted, 0);
  assert.equal((await collect(b, [item], new Date(now.getTime() + 2000))).inserted, 0);
  const data = await sourceQualityData(7, undefined, now);
  assert.equal(data.metrics.find((s) => s.id === a)?.discovered, 1);
  assert.equal(data.metrics.find((s) => s.id === b)?.discovered, 1);
  assert.equal(data.metrics.find((s) => s.id === a)?.inserted, 1);
  assert.equal(data.metrics.find((s) => s.id === b)?.inserted, 0);
  assert.equal(data.metrics.find((s) => s.id === a)?.repeated_items, 1);
  assert.equal(data.metrics.find((s) => s.id === a)?.observed_items, 2);
  assert.equal(data.metrics.find((s) => s.id === b)?.observed_items, 1);
  assert.deepEqual(
    (await pool.query('SELECT outcome FROM collection_items ORDER BY id')).rows.map(
      (r) => r.outcome,
    ),
    ['new', 'repeated', 'known'],
  );
  assert.equal((await pool.query('SELECT count(*)::int n FROM articles')).rows[0].n, 1);
});
test('过期、未来和无效条目留采集痕迹，但不新增原始资讯，也不删除既有资讯', async () => {
  const id = await source('过滤源');
  await collect(id, [item]);
  await collect(id, [
    { ...item, url: 'https://example.invalid/old', publishedAt: '2026-10-21T00:00:00Z' },
    { ...item, url: 'https://example.invalid/future', publishedAt: '2026-10-30T00:00:00Z' },
    { title: '缺少日期', url: 'https://example.invalid/bad' },
  ]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM articles')).rows[0].n, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM collection_items WHERE outcome='outside_window'",
      )
    ).rows[0].n,
    2,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM collection_items WHERE outcome='invalid'"))
      .rows[0].n,
    1,
  );
});
test('事件重叠按不同信源判定，最早发现和独家贡献分开，不把待处理算淘汰', async () => {
  const a = await source('A'),
    b = await source('B');
  await collect(a, [
    item,
    { ...item, url: 'https://example.invalid/exclusive' },
    { ...item, url: 'https://example.invalid/pending' },
  ]);
  await collect(b, [item], new Date(now.getTime() + 1000));
  const assessment = Object.fromEntries(
    defaultSettings.ratingRules.map((r) => [r.id, { score: 5, reason: '具备充分证据' }]),
  );
  for (const url of [item.url, 'https://example.invalid/exclusive']) {
    const event = (
      await pool.query(
        "INSERT INTO events(industry_id,title,summary,section,score,assessment,occurred_at) VALUES('ai','事件','摘要','工具与开源',100,$1,now()) RETURNING id",
        [JSON.stringify(assessment)],
      )
    ).rows[0].id;
    const article = (
      await pool.query(
        "UPDATE articles SET state='processed',event_id=$1,assessment=$2 WHERE url=$3 RETURNING id",
        [event, JSON.stringify(assessment), url],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO event_developments(event_id,article_id,fact_hash,facts,happened_at) VALUES($1,$2,$3,'[]',now())",
      [event, article, url],
    );
  }
  const data = await sourceQualityData(7, undefined, now);
  const first = data.metrics.find((s) => s.id === a)!,
    second = data.metrics.find((s) => s.id === b)!;
  assert.equal(first.qualified, 2);
  assert.equal(first.exclusive, 1);
  assert.equal(first.first, 2);
  assert.equal(second.qualified, 1);
  assert.equal(second.exclusive, 0);
  assert.equal(second.first, 0);
  assert.equal(first.pending, 1);
  assert.equal(first.ignored, 0);
  assert.equal(data.discoveries.find((d) => d.source_id === b)?.relation, 'duplicate');
  const range = discoveryRange('2026-10-29');
  assert.equal(range.start.toISOString(), '2026-10-28T16:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-10-29T16:00:00.000Z');
});

test('信源监控遵守配置顺序，启用状态和贡献量不改变位置，AIHOT在末尾', async () => {
  await pool.query(`INSERT INTO sources(name,url,format,industry_id,enabled,sort_order) VALUES
    ('AIHOT','https://example.invalid/aihot','rss','ai',true,2147483647),
    ('第二项','https://example.invalid/second','rss','ai',true,2),
    ('第一项',NULL,'manual','ai',false,1)`);
  const result = await sourceQualityData(30, undefined, now);
  assert.deepEqual(
    result.metrics.map((row) => row.name),
    ['第一项', '第二项', 'AIHOT'],
  );
});
