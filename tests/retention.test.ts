import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, pool } from '../src/server/db.ts';
import { articles, events, briefs, deliveries } from '../src/server/schema.ts';
import { migrate } from '../scripts/migrate.ts';
import { getQueue } from '../src/server/queue.ts';
import { saveSettings, getSettings } from '../src/server/settings.ts';
import { defaultSettings } from '../src/server/types.ts';
import { cleanupRetention, mailRetentionCutoff } from '../src/server/retention.ts';
import { fixtureContent } from './fixtures.ts';
import { publishedBrief, latestNews } from '../src/server/publication.ts';
import { subscribe } from '../src/server/subscriptions.ts';
import type { PgBoss } from 'pg-boss';
if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('清理测试必须连接独立_test数据库');
let boss: PgBoss;
const now = new Date('2026-11-02T04:00:00Z');
const old = new Date('2026-09-15T00:00:00Z');
before(async () => {
  await migrate();
  boss = await getQueue();
});
beforeEach(async () => {
  for (const queue of ['collect', 'process', 'generate', 'deliver', 'tick', 'cleanup'])
    await boss.deleteAllJobs(queue);
  await pool.query(
    'TRUNCATE processing_steps, collection_runs, model_calls, brief_requests, subscriptions, briefs, articles, events CASCADE',
  );
  await saveSettings({
    ...defaultSettings,
    retentionEnabled: true,
    monthlyEnabled: false,
    weeklyEnabled: false,
    dailyEnabled: false,
    startDate: '2026-09-01',
  });
  process.env.APP_SECRET = 'test-only-retention-secret-32-characters';
});
after(async () => {
  await boss.stop();
  await pool.end();
});
async function article(at: Date) {
  const eventId = randomUUID(),
    articleId = randomUUID();
  await db.insert(events).values({
    id: eventId,
    industryId: 'finance',
    title: '测试资讯',
    summary: '摘要',
    section: '行业监管',
    score: 80,
    occurredAt: at,
  });
  await db.insert(articles).values({
    id: articleId,
    eventId,
    industryId: 'finance',
    sourceName: '测试来源',
    url: `https://example.invalid/${articleId}`,
    title: '测试资讯',
    excerpt: '摘要',
    publishedAt: at,
    state: 'processed',
  });
  return { eventId, articleId };
}
test('过期资讯、任务与过程数据清理后，已发布简报的快照和链接完整保留', async () => {
  const source = await article(old);
  const content = fixtureContent();
  content.items[0].eventId = source.eventId;
  const [brief] = await db
    .insert(briefs)
    .values({ kind: 'daily', periodDate: '2026-09-15', published: content })
    .returning();
  await pool.query(
    "INSERT INTO collection_runs(source_name,url,started_at,finished_at,state) VALUES('test','https://example.invalid',$1,$1,'succeeded')",
    [old],
  );
  const calls = await pool.query(
    "INSERT INTO model_calls(purpose,state,subject,created_at,finished_at) VALUES('article','succeeded',$2,$1,$1) RETURNING id",
    [old, 'article:' + source.articleId],
  );
  await pool.query(
    "INSERT INTO processing_steps(subject,run_key,stage,state,started_at,finished_at,call_id) VALUES($2,'test','analyze','succeeded',$1,$1,$3)",
    [old, 'article:' + source.articleId, calls.rows[0].id],
  );
  const job = await boss.send('collect', { id: randomUUID() });
  await pool.query("UPDATE pgboss.job SET state='completed',completed_on=$2 WHERE id=$1", [
    job,
    old,
  ]);
  const result = await cleanupRetention(now);
  assert.equal(result.counts.events, 1);
  assert.equal(result.counts.articles, 1);
  assert.equal(result.counts.processingSteps, 1);
  assert.equal(result.counts.modelCalls, 1);
  assert.equal(result.counts.collectionRuns, 1);
  assert.equal(result.counts.jobs, 1);
  assert.deepEqual((await publishedBrief(brief.id))?.content, content);
  assert.equal((await cleanupRetention(now)).counts.events, 0);
});
test('排队中的旧资讯和等待额度的处理记录不被清理', async () => {
  const source = await article(old);
  await boss.send('process', { id: source.articleId });
  await pool.query(
    "INSERT INTO processing_steps(subject,run_key,stage,state,started_at) VALUES($1,'test','task','waiting',$2)",
    ['article:' + source.articleId, old],
  );
  const result = await cleanupRetention(now);
  assert.equal(result.counts.events, 0);
  assert.equal(result.counts.articles, 0);
  assert.equal((await pool.query('SELECT 1 FROM processing_steps')).rowCount, 1);
});
test('邮件记录每日按滚动7天清理，保留边界时刻与未结束投递', async () => {
  const content = fixtureContent();
  const [brief] = await db
    .insert(briefs)
    .values({ kind: 'daily', periodDate: '2026-10-26', published: content })
    .returning();
  const cutoff = new Date(now.getTime() - 7 * 86400000);
  const expired = new Date(cutoff.getTime() - 1);
  for (const [i, state, at] of [
    [0, 'sent', expired],
    [1, 'failed', expired],
    [2, 'uncertain', expired],
    [3, 'pending', expired],
    [4, 'sending', expired],
    [5, 'sent', cutoff],
  ] as const) {
    await subscribe({ email: `reader${i}@example.invalid`, kinds: ['daily'] });
    const sub = await pool.query('SELECT id FROM subscriptions WHERE email=$1', [
      `reader${i}@example.invalid`,
    ]);
    await db
      .insert(deliveries)
      .values({ briefId: brief.id, subscriptionId: sub.rows[0].id, state, createdAt: at });
  }
  assert.equal(
    mailRetentionCutoff(now, await getSettings()).toISOString(),
    '2026-10-26T04:00:00.000Z',
  );
  const result = await cleanupRetention(now);
  assert.equal(result.counts.deliveries, 3);
  assert.deepEqual((await db.select().from(deliveries)).map((r) => r.state).sort(), [
    'pending',
    'sending',
    'sent',
  ]);
});
test('未出刊月报的统计材料暂缓物理删除，月报发布后按规则删除', async () => {
  await saveSettings({
    ...(await getSettings()),
    monthlyEnabled: true,
    monthlyDay: 1,
    monthlyTime: '08:00',
  });
  await article(new Date('2026-10-01T01:00:00Z'));
  assert.equal((await cleanupRetention(now)).counts.events, 0);
  await db
    .insert(briefs)
    .values({ kind: 'monthly', periodDate: '2026-11-01', published: fixtureContent() });
  assert.equal((await cleanupRetention(now)).counts.events, 1);
});
test('清理规则可保存，关闭清理时不删除；7×24隐藏超过配置天数的资讯', async () => {
  await article(new Date(Date.now() - 40 * 86400000));
  await article(new Date());
  assert.equal((await latestNews()).length, 1);
  await saveSettings({
    ...(await getSettings()),
    retentionEnabled: false,
    newsRetentionDays: 45,
    taskRetentionDays: 60,
    mailRetentionDays: 14,
  });
  const config = await getSettings();
  assert.equal(config.newsRetentionDays, 45);
  assert.equal(config.mailRetentionDays, 14);
  assert.ok((await cleanupRetention(now)).skipped);
  assert.equal((await latestNews()).length, 2);
  await assert.rejects(saveSettings({ ...config, newsRetentionDays: 0 }));
});
