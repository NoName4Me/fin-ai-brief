import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/server/db.ts';
import { migrate } from '../scripts/migrate.ts';
import { getQueue, enqueue, executeTask } from '../src/server/queue.ts';
import { taskOverview, taskDetail, retryManagedTask } from '../src/server/admin-tasks.ts';
import { requestGeneration } from '../src/server/generation-requests.ts';
import { saveSettings } from '../src/server/settings.ts';
import { defaultSettings } from '../src/server/types.ts';
import { taskStamp } from '../src/server/task-labels.ts';
import type { PgBoss } from 'pg-boss';
if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('任务管理测试必须使用独立_test库');
let boss: PgBoss;
before(async () => {
  await migrate();
  boss = await getQueue();
});
beforeEach(async () => {
  for (const name of ['collect', 'process', 'generate']) await boss.deleteAllJobs(name);
  await pool.query(
    'TRUNCATE articles,events,sources,brief_requests,processing_steps,model_calls CASCADE',
  );
  await saveSettings(defaultSettings);
});
after(async () => {
  await boss.stop();
  await pool.end();
});
async function article(title = '资讯标题') {
  return (
    await pool.query(
      "INSERT INTO articles(title,url,excerpt,published_at,source_name,industry_id) VALUES($1,$2,'摘要','2026-10-21T12:00:00Z','测试','ai') RETURNING id",
      [title, `https://example.invalid/${randomUUID()}`],
    )
  ).rows[0].id as string;
}
async function source() {
  return (
    await pool.query(
      "INSERT INTO sources(name,url,format,industry_id) VALUES('测试信源','https://example.invalid/rss','rss','ai') RETURNING id",
    )
  ).rows[0].id as string;
}

test('三个任务类型在同一列表中，类型、状态和任务名在合并后筛选', async () => {
  const sourceId = await source(),
    articleId = await article();
  const collectId = await enqueue('collect', { id: sourceId }, sourceId);
  const processId = await enqueue('process', { id: articleId }, articleId);
  const generationId = await enqueue(
    'generate',
    { kind: 'daily', date: '2026-10-22', trigger: 'auto' },
    'daily:2026-10-22',
  );
  const tasks = await taskOverview();
  assert.equal(tasks.length, 3);
  assert.deepEqual(new Set(tasks.map((t) => t.queue)), new Set(['collect', 'process', 'generate']));
  assert.equal(tasks[0].job_id, generationId);
  assert.equal(tasks.find((t) => t.job_id === processId)?.name, '资讯标题');
  assert.equal(tasks.find((t) => t.job_id === collectId)?.name, '测试信源');
  assert.match(tasks[0].name, /日报 2026-10-22（自动）/);
  assert.equal((await taskOverview('', 'process')).length, 1);
  assert.equal((await taskOverview('测试信源')).length, 1);
  assert.equal((await taskOverview('', 'generate', 'created')).length, 1);
  assert.equal((await taskOverview('', 'generate', 'failed')).length, 0);
  assert.equal(taskStamp(null), '未开始');
  assert.equal(taskStamp('2026-10-23T15:33:17Z'), '2026-10-23 23:33:17');
});

test('自动重试保留一行，最终失败后手动重试新建任务并保留原记录', async () => {
  const id = await article();
  const jobId = await enqueue('process', { id }, id);
  await pool.query('UPDATE pgboss.job SET retry_delay=0,retry_backoff=false WHERE id=$1', [jobId]);
  const [first] = await boss.fetch('process');
  await boss.fail('process', first.id, { message: '临时失败' });
  assert.equal((await taskOverview('', 'process')).length, 1);
  assert.equal((await taskOverview('', 'process'))[0].state, 'retry');
  const [second] = await boss.fetch('process');
  await assert.rejects(
    executeTask('process', second.id, { id }, async () => {
      throw new Error('重试失败');
    }),
  );
  await boss.fail('process', second.id, { message: '重试失败' });
  assert.equal((await taskOverview('', 'process'))[0].state, 'failed');
  const newId = await retryManagedTask(`job:${jobId}`);
  assert.notEqual(newId, jobId);
  const tasks = await taskOverview('', 'process');
  assert.equal(tasks.length, 2);
  assert.equal(tasks.filter((t) => t.state === 'failed').length, 1);
  assert.equal(tasks.filter((t) => t.state === 'created').length, 1);
});

test('手动出刊请求从等待资讯到进入队列只显示一行，保留手动标签', async () => {
  const requestId = await requestGeneration('daily', '2026-10-22', { force: true });
  const tasks = await taskOverview('', 'generate');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, `request:${requestId}`);
  assert.match(tasks[0].name, /（手动）/);
  assert.equal(tasks[0].state, 'created');
  const detail = await taskDetail(tasks[0].id);
  assert.equal(detail?.attempts.length, 1);
  assert.equal(detail?.task.job_id, tasks[0].job_id);
});

test('未入队资讯不伪造开始时间，入队后不重复显示占位任务', async () => {
  const id = await article();
  const waiting = await taskOverview();
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].started_on, null);
  assert.equal(waiting[0].target_id, id);
  const requestId = await requestGeneration('daily', '2026-10-22', { force: true });
  const tasks = await taskOverview();
  assert.equal(tasks.length, 2);
  assert.equal(tasks.filter((t) => t.queue === 'process').length, 1);
  assert.equal(tasks.find((t) => t.request_id === requestId)?.state, 'waiting_articles');
  assert.ok(tasks.find((t) => t.queue === 'process')?.job_id);
});

test('信源改名或删除后保留入队时的任务名，详情时间线倒序', async () => {
  const id = await source();
  const jobId = await enqueue('collect', { id }, id);
  await pool.query('DELETE FROM sources WHERE id=$1', [id]);
  assert.equal((await taskOverview())[0].name, '测试信源');
  await pool.query(
    "INSERT INTO processing_steps(subject,run_key,stage,state,started_at) VALUES($1,$2,'task','failed',now())",
    [`source:${id}`, `job:${jobId}`],
  );
  const detail = await taskDetail(`job:${jobId}`);
  assert.equal(detail?.source, null);
  assert.equal(detail?.steps[0].stage, 'task');
  assert.equal(await taskDetail(`job:${randomUUID()}`), null);
  assert.equal(await taskDetail('invalid'), null);
});
