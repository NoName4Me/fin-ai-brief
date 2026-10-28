import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../scripts/migrate.ts';
import { pool } from '../src/server/db.ts';
import { adminOverview } from '../src/server/admin-overview.ts';
import { getSettings, saveSettings } from '../src/server/settings.ts';
import { fixtureContent } from './fixtures.ts';

if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('必须使用独立_test数据库');
before(migrate);
after(() => pool.end());

test('总览按北京时间统计入库，区分信源失败、首采、逾期与暂停，展示真实出刊状态', async () => {
  const original = await getSettings();
  const now = new Date('2035-01-02T04:00:00Z');
  const ids = Array.from({ length: 7 }, () => randomUUID());
  const issueId = randomUUID();
  try {
    await saveSettings({ ...original, collectionEnabled: true });
    const baseline = await adminOverview(now);
    for (const [index, state] of [
      'healthy',
      'failed',
      'retry',
      'new',
      'overdue',
      'disabled',
    ].entries()) {
      await pool.query(
        `INSERT INTO sources(id,name,url,format,industry_id,enabled,last_fetched_at,last_error,failure_count,next_fetch_at)
        VALUES($1,$2,'https://example.invalid/overview/'||($1::uuid)::text,'rss','ai',$3,$4,$5,$6,$7)`,
        [
          ids[index],
          '总览-' + state,
          state !== 'disabled',
          state === 'new'
            ? null
            : new Date(now.getTime() - (state === 'overdue' ? 86400000 : 60000)),
          ['failed', 'retry', 'disabled'].includes(state) ? '采集失败' : null,
          state === 'failed' || state === 'disabled' ? 3 : state === 'retry' ? 1 : 0,
          new Date(now.getTime() - 3600000),
        ],
      );
    }
    for (const [index, createdAt] of [
      '2035-01-01T15:59:59Z',
      '2035-01-01T16:00:00Z',
      '2035-01-02T16:00:00Z',
    ].entries()) {
      await pool.query(
        `INSERT INTO articles(title,url,excerpt,published_at,source_name,industry_id,state,created_at)
        VALUES('延迟入库资讯',$1,'AI更新','2034-12-20','总览验证','ai','processed',$2)`,
        [`https://example.invalid/overview/${ids[6]}/${index}`, createdAt],
      );
    }
    await pool.query(
      `INSERT INTO briefs(id,kind,period_date,draft) VALUES($1,'daily','2035-01-02',$2)`,
      [issueId, fixtureContent()],
    );
    const overview = await adminOverview(now);
    assert.equal(overview.counts.incoming, baseline.counts.incoming + 1);
    assert.equal(overview.status, '待审核');
    assert.equal(overview.sources.length, baseline.sources.length + 5);
    for (const [index, state] of ['healthy', 'failed', 'retry', 'new', 'overdue'].entries())
      assert.equal(overview.sources.find((source) => source.id === ids[index])?.state, state);
    assert.equal(
      overview.sources.some((source) => source.id === ids[5]),
      false,
    );
    await saveSettings({ ...original, collectionEnabled: false });
    const paused = await adminOverview(now);
    assert.equal(paused.sources.find((source) => source.id === ids[4])?.state, 'paused');
    assert.equal(paused.sources.find((source) => source.id === ids[1])?.state, 'failed');
  } finally {
    await pool.query('DELETE FROM sources WHERE id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM articles WHERE url LIKE $1', [
      `https://example.invalid/overview/${ids[6]}/%`,
    ]);
    await pool.query('DELETE FROM briefs WHERE id=$1', [issueId]);
    await saveSettings(original);
  }
});
