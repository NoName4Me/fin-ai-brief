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

test('总览按配置出刊周期统计入库，区分信源失败、首采、逾期与暂停，展示真实出刊状态', async () => {
  const original = await getSettings();
  const now = new Date('2035-01-02T04:00:00Z');
  const ids = Array.from({ length: 7 }, () => randomUUID());
  const issueId = randomUUID();
  const publishedIssueId = randomUUID();
  const currentTokenArticleId = randomUUID();
  const previousTokenArticleId = randomUUID();
  try {
    await saveSettings({ ...original, collectionEnabled: true, dailyTime: '08:00' });
    await pool.query('DELETE FROM model_calls WHERE subject=ANY($1::text[])', [
      ['brief:daily:2035-01-03', 'brief:daily:2035-01-02'],
    ]);
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
      '2035-01-01T23:59:59Z',
      '2035-01-02T00:00:00Z',
      '2035-01-02T12:00:00Z',
    ].entries()) {
      await pool.query(
        `INSERT INTO articles(title,url,excerpt,published_at,source_name,industry_id,state,created_at)
        VALUES('延迟入库资讯',$1,'AI更新','2034-12-20','总览验证','ai','processed',$2)`,
        [`https://example.invalid/overview/${ids[6]}/${index}`, createdAt],
      );
    }
    for (const [index, [state, createdAt]] of [
      ['pending', '2035-01-02T01:00:00Z'],
      ['pending', '2035-01-01T23:59:59Z'],
      ['failed', '2035-01-02T02:00:00Z'],
      ['failed', '2035-01-01T23:59:59Z'],
    ].entries()) {
      await pool.query(
        `INSERT INTO articles(title,url,excerpt,published_at,source_name,industry_id,state,created_at)
        VALUES('周期待办资讯',$1,'AI更新','2034-12-20','总览验证','ai',$2,$3)`,
        [`https://example.invalid/overview/${ids[6]}/state-${index}`, state, createdAt],
      );
    }
    await pool.query(
      `INSERT INTO briefs(id,kind,period_date,draft) VALUES($1,'daily','2035-01-03',$2)`,
      [issueId, fixtureContent()],
    );
    await pool.query(
      `INSERT INTO briefs(id,kind,period_date,published,published_at) VALUES($1,'daily','2035-01-02',$2,$3)`,
      [publishedIssueId, fixtureContent(), now],
    );
    for (const [id, createdAt] of [
      [currentTokenArticleId, '2035-01-02T01:00:00Z'],
      [previousTokenArticleId, '2035-01-01T20:00:00Z'],
    ]) {
      await pool.query(
        `INSERT INTO articles(id,title,url,excerpt,published_at,source_name,industry_id,state,created_at)
         VALUES($1,'token 周期资讯',$2,'AI更新','2034-12-20','总览验证','ai','processed',$3)`,
        [id, `https://example.invalid/overview/token/${id}`, createdAt],
      );
    }
    for (const [subject, input, output] of [
      ['brief:daily:2035-01-03', 120, 30],
      ['brief:daily:2035-01-02', 45, 5],
      [`article:${currentTokenArticleId}`, 20, 10],
      [`article:${previousTokenArticleId}`, 10, 5],
    ]) {
      await pool.query(
        `INSERT INTO model_calls(purpose,state,subject,input_tokens,output_tokens)
         VALUES('brief','succeeded',$1,$2,$3)`,
        [subject, input, output],
      );
    }
    const overview = await adminOverview(now);
    assert.equal(overview.counts.incoming, baseline.counts.incoming + 4);
    assert.equal(overview.counts.pending, baseline.counts.pending + 1);
    assert.equal(overview.counts.failed, baseline.counts.failed + 1);
    assert.equal(overview.nextIssueDate, '2035-01-03');
    assert.equal(overview.latestPublished?.id, publishedIssueId);
    assert.deepEqual(overview.tokenUsage, { current: 180, previous: 65 });
    assert.equal(overview.exceptions.since.toISOString(), '2035-01-02T00:00:00.000Z');
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
    await pool.query('DELETE FROM articles WHERE id=ANY($1::uuid[])', [
      [currentTokenArticleId, previousTokenArticleId],
    ]);
    await pool.query('DELETE FROM briefs WHERE id=ANY($1::uuid[])', [[issueId, publishedIssueId]]);
    await pool.query('DELETE FROM model_calls WHERE subject=ANY($1::text[])', [
      [
        'brief:daily:2035-01-03',
        'brief:daily:2035-01-02',
        `article:${currentTokenArticleId}`,
        `article:${previousTokenArticleId}`,
      ],
    ]);
    await saveSettings(original);
  }
});
