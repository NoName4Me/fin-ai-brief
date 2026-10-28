import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PgBoss } from 'pg-boss';
import { migrate } from '../scripts/migrate.ts';
import { pool } from '../src/server/db.ts';
import { getQueue, enqueue } from '../src/server/queue.ts';
import { saveSettings } from '../src/server/settings.ts';
import { defaultSettings } from '../src/server/types.ts';
import { requestReprocessing } from '../src/server/reprocessing.ts';
import { taskOverview, retryManagedTask } from '../src/server/admin-tasks.ts';
import { batchDetail } from '../src/server/admin-reprocessing.ts';
if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('仅允许独立_test数据库');
let boss: PgBoss;
before(async () => {
  await migrate();
  boss = await getQueue();
});
beforeEach(async () => {
  await boss.deleteAllJobs('process');
  await boss.deleteAllJobs('generate');
  await boss.deleteAllJobs('collect');
  await pool.query(
    'TRUNCATE reprocessing_batches,brief_requests,processing_steps,model_calls,articles,events,sources CASCADE',
  );
  await saveSettings(defaultSettings);
});
after(async () => {
  await boss.stop();
  await pool.end();
});
async function batch(size = 2, regenerateDate?: string) {
  const ids: string[] = [];
  for (let i = 0; i < size; i++)
    ids.push(
      (
        await pool.query(
          "INSERT INTO articles(title,url,excerpt,published_at,source_name,industry_id,state,processing_version) VALUES($1,'https://example.invalid/'||gen_random_uuid(),'AI更新','2026-10-21T12:00:00Z','来源','ai','processed','old') RETURNING id",
          [`批次资讯-${i}`],
        )
      ).rows[0].id,
    );
  const requested = await requestReprocessing({
    from: '2026-10-21T00:00:00Z',
    to: '2026-10-22T00:00:00Z',
    scope: 'all',
    regenerateDate,
  });
  return { ...requested, ids };
}

test('批次在主列表只占一行，批内任务与待入队资讯隐藏，详情保留全部结果', async () => {
  const b = await batch(3);
  for (const id of b.ids.slice(0, 2)) {
    const job = await enqueue('process', { id, reprocessBatchId: b.id }, id);
    await pool.query(
      "UPDATE reprocessing_items SET state='queued',job_id=$3 WHERE batch_id=$1 AND article_id=$2",
      [b.id, id, job],
    );
  }
  await pool.query("UPDATE reprocessing_batches SET state='processing' WHERE id=$1", [b.id]);
  await pool.query("UPDATE articles SET state='pending' WHERE id=ANY($1::uuid[])", [b.ids]);
  const rows = await taskOverview();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].queue, 'reprocess');
  assert.equal(rows[0].data.total, 3);
  assert.equal((await taskOverview('', 'process')).length, 0);
  assert.equal((await taskOverview(b.id, 'reprocess', 'active')).length, 1);
  const detail = await batchDetail(b.id);
  assert.equal(detail?.items.length, 3);
  assert.equal(detail?.counts.queued, 2);
  assert.equal(detail?.counts.waiting, 1);
});

test('重试仅重置失败项，保留成功结果并拒绝重复重试运行中批次', async () => {
  const b = await batch();
  await pool.query("UPDATE reprocessing_items SET state='processed' WHERE article_id=$1", [
    b.ids[0],
  ]);
  await pool.query(
    "UPDATE reprocessing_items SET state='failed',error='超时' WHERE article_id=$1",
    [b.ids[1]],
  );
  await pool.query(
    "UPDATE reprocessing_batches SET state='completed_with_errors',finished_at=now() WHERE id=$1",
    [b.id],
  );
  await retryManagedTask(`batch:${b.id}`);
  const detail = await batchDetail(b.id);
  assert.equal(detail?.batch.state, 'waiting');
  assert.equal(detail?.counts.processed, 1);
  assert.equal(detail?.counts.waiting, 1);
  assert.equal(detail?.counts.failed, 0);
  await assert.rejects(retryManagedTask(`batch:${b.id}`), /等待批次结束/);
});

test('日报生成失败重试仍属于同一批次，不重做资讯且保留不发邮件标记', async () => {
  const b = await batch(1, '2026-10-22');
  await pool.query("UPDATE reprocessing_items SET state='ignored' WHERE batch_id=$1", [b.id]);
  await pool.query(
    "UPDATE reprocessing_batches SET state='failed',error='生成失败',finished_at=now() WHERE id=$1",
    [b.id],
  );
  await retryManagedTask(`batch:${b.id}`);
  const jobs = await pool.query(
    "SELECT * FROM pgboss.job WHERE name='generate' AND data->>'reprocessBatchId'=$1",
    [b.id],
  );
  assert.equal(jobs.rows.length, 1);
  assert.equal(jobs.rows[0].data.publishWithoutMail, true);
  assert.equal((await batchDetail(b.id))?.counts.ignored, 1);
  assert.equal((await taskOverview('', 'generate')).length, 1);
  assert.equal((await taskOverview('', 'reprocess', 'generating')).length, 1);
});
