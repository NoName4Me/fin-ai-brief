import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { PgBoss } from 'pg-boss';
import { migrate } from '../scripts/migrate.ts';
import { pool } from '../src/server/db.ts';
import { getQueue, executeTask } from '../src/server/queue.ts';
import { processingController } from '../src/server/processing-worker.ts';
import { defaultSettings } from '../src/server/types.ts';
import { saveSettings, getSettings } from '../src/server/settings.ts';
import {
  requestReprocessing,
  dispatchReprocessingBatches,
  reprocessingBatches,
} from '../src/server/reprocessing.ts';
import { runGeneration, type GenerationTask } from '../src/server/generation-requests.ts';
import { taskDetail } from '../src/server/admin-tasks.ts';
import { retryJob } from '../src/server/admin-tasks.ts';
import { subscribe } from '../src/server/subscriptions.ts';
if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('必须使用独立_test数据库');
let boss: PgBoss;
const originalFetch = globalThis.fetch;
const range = { from: '2026-10-21T00:00:00Z', to: '2026-10-22T00:00:00Z', scope: 'all' as const };
before(async () => {
  await migrate();
  boss = await getQueue();
});
beforeEach(async () => {
  await boss.deleteAllJobs('process');
  await boss.deleteAllJobs('generate');
  await pool.query(
    'TRUNCATE reprocessing_batches,edition_runs,processing_steps,model_calls,brief_requests,collection_runs,source_hosts,deliveries,subscriptions,briefs,articles,events,sources CASCADE',
  );
  await saveSettings({
    ...defaultSettings,
    autoPublish: true,
    rotationsEnabled: false,
    processingConcurrency: 2,
  });
  process.env.MODEL_CALLS_ENABLED = 'true';
  process.env.MAIL_ENABLED = 'false';
  process.env.APP_SECRET = 'reprocessing-test-secret-long-enough';
  process.env.LLM_API_KEY = 'test';
  process.env.LLM_MODEL = 'test';
  process.env.LLM_BASE_URL = 'http://model.invalid/v1';
  globalThis.fetch = async () => {
    throw new Error('创建和调度批次不能直接请求模型');
  };
});
after(async () => {
  globalThis.fetch = originalFetch;
  await boss.stop();
  await pool.end();
});
async function article(title = 'AI工具更新') {
  return (
    await pool.query(
      `INSERT INTO articles(title,url,excerpt,published_at,source_name,industry_id,state,processing_version)
    VALUES($1,'https://example.invalid/'||gen_random_uuid(),'机构公布工具更新，保留使用条件。','2026-10-21T12:00:00Z','测试来源','finance','processed','facts-v1') RETURNING id`,
      [title],
    )
  ).rows[0].id as string;
}
test('创建批次只记录范围和原始状态，不直接改资讯或调用模型', async () => {
  const id = await article();
  const batch = await requestReprocessing(range);
  assert.equal(batch.total, 1);
  assert.equal(
    (await pool.query('SELECT state FROM articles WHERE id=$1', [id])).rows[0].state,
    'processed',
  );
  const item = (
    await pool.query('SELECT state,article_snapshot FROM reprocessing_items WHERE batch_id=$1', [
      batch.id,
    ])
  ).rows[0];
  assert.equal(item.state, 'waiting');
  assert.equal(item.article_snapshot.processing_version, 'facts-v1');
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM pgboss.job WHERE name='process'")).rows[0].n,
    0,
  );
});
test('调度器创建正常处理任务并传递批次版本，重复调度不重复入队', async () => {
  const id = await article();
  const batch = await requestReprocessing(range);
  await dispatchReprocessingBatches();
  await dispatchReprocessingBatches();
  const { rows } = await pool.query(
    "SELECT data,priority FROM pgboss.job WHERE name='process' AND state='created'",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.id, id);
  assert.equal(rows[0].data.reprocessBatchId, batch.id);
  assert.equal(rows[0].priority, 100);
  assert.equal(
    (await pool.query('SELECT state FROM articles WHERE id=$1', [id])).rows[0].state,
    'pending',
  );
});
test('重叠批次拒绝创建，不能重复消费同一批资讯', async () => {
  await article();
  await requestReprocessing(range);
  await assert.rejects(requestReprocessing(range), /未完成/);
});
test('额度不足保持待安排，不重置资讯或绕过额度', async () => {
  const id = await article();
  await saveSettings({ ...(await getSettings()), modelDailyLimit: 1 });
  await requestReprocessing(range);
  await dispatchReprocessingBatches();
  assert.equal(
    (await pool.query('SELECT state FROM articles WHERE id=$1', [id])).rows[0].state,
    'processed',
  );
  assert.equal((await reprocessingBatches())[0].waiting, 1);
});
test('原处理任务执行时等待，不能覆盖进行中的工作', async () => {
  const id = await article();
  await boss.send('process', { id }, { singletonKey: id });
  await boss.fetch('process');
  await requestReprocessing(range);
  await dispatchReprocessingBatches();
  assert.equal((await reprocessingBatches())[0].waiting, 1);
  assert.equal(
    (await pool.query('SELECT state FROM articles WHERE id=$1', [id])).rows[0].state,
    'processed',
  );
});
test('默认仅重跑旧规则或失败资讯，并校验日报覆盖范围', async () => {
  await article();
  await assert.rejects(
    requestReprocessing({ ...range, from: '2026-10-21T12:00:00Z', regenerateDate: '2026-10-22' }),
    /完整覆盖/,
  );
  await assert.rejects(requestReprocessing({ ...range, to: '2026-12-01T00:00:00Z' }), /31天/);
});
test('从任务管理重试失败出刊时恢复批次关联，保持不发送邮件标记', async () => {
  await article();
  const batch = await requestReprocessing({ ...range, regenerateDate: '2026-10-22' });
  const previous = await boss.send('generate', {
    kind: 'daily',
    date: '2026-10-22',
    backfill: true,
    publishWithoutMail: true,
    reprocessBatchId: batch.id,
  });
  await pool.query("UPDATE pgboss.job SET state='failed' WHERE id=$1", [previous]);
  await pool.query(
    "UPDATE reprocessing_batches SET state='failed',error='字数超限',generation_job_id=$2 WHERE id=$1",
    [batch.id, previous],
  );
  const next = await retryJob('generate', previous!);
  const saved = (
    await pool.query('SELECT state,error,generation_job_id FROM reprocessing_batches WHERE id=$1', [
      batch.id,
    ])
  ).rows[0];
  assert.equal(saved.state, 'generating');
  assert.equal(saved.error, null);
  assert.equal(saved.generation_job_id, next);
  assert.equal(
    (await pool.query('SELECT data FROM pgboss.job WHERE id=$1', [next])).rows[0].data
      .publishWithoutMail,
    true,
  );
});
test('真实队列消费者完成重处理、归组与日报更新，原刊保留到更新成功且不产生投递', async () => {
  await article();
  await article('普通金融消息');
  process.env.MAIL_ENABLED = 'true';
  await subscribe({ email: 'replay@example.invalid', kinds: ['daily'] });
  const assessment = Object.fromEntries(
    ['relevance', 'impact', 'timeliness', 'actionability', 'novelty'].map((k) => [
      k,
      { score: k === 'relevance' ? 5 : 4, reason: '材料提供明确依据' },
    ]),
  );
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    const value = input.article
      ? input.article.title.includes('普通')
        ? { relevant: false, reason: '与AI无关' }
        : {
            relevant: true,
            title: input.article.title,
            summary: '机构公布工具更新，保留使用条件。',
            section: '工具与开源',
            assessment,
            tags: ['开源'],
            existingEventId: null,
            novelty: 'new',
            facts: [
              {
                statement: '机构公布工具更新',
                evidence: '机构公布工具更新',
                status: 'announced',
                entities: [],
              },
            ],
          }
      : {
          title: 'AI工具进展',
          items: (input.selected ?? []).map((e: { id: string }) => ({
            eventId: e.id,
            title: 'AI工具更新',
            summary: '机构公布工具更新，保留使用条件。',
          })),
          highlights: [],
          rotations: [],
        };
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    );
  };
  await processingController(boss)();
  await boss.work<GenerationTask>('generate', async ([job]) =>
    executeTask('generate', job.id, { ...job.data }, () => runGeneration(job.id, job.data)),
  );
  const batch = await requestReprocessing({ ...range, regenerateDate: '2026-10-22' });
  const deadline = Date.now() + 12000;
  let current = (await reprocessingBatches())[0];
  while (
    !['completed', 'failed', 'completed_with_errors'].includes(current.state) &&
    Date.now() < deadline
  ) {
    await dispatchReprocessingBatches();
    await delay(100);
    current = (await reprocessingBatches())[0];
  }
  assert.equal(current.state, 'completed', current.error ?? '批次未完成');
  assert.equal(current.processed, 1);
  assert.equal(current.ignored, 1);
  assert.equal(calls, 5);
  const brief = (
    await pool.query("SELECT published FROM briefs WHERE kind='daily' AND period_date='2026-10-22'")
  ).rows[0];
  assert.equal(brief.published.format, 'ai-daily-v1');
  assert.equal(brief.published.items.length, 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM deliveries')).rows[0].n, 0);
  const generation = (
    await pool.query('SELECT generation_job_id FROM reprocessing_batches WHERE id=$1', [batch.id])
  ).rows[0].generation_job_id;
  const detail = await taskDetail('job:' + generation);
  assert.equal(detail?.edition.length, 9);
  const section = detail?.edition.find((s) => s.section === '工具与开源');
  assert.equal(section?.details[0].rating, 4.3);
  assert.equal(section?.details[0].selected, true);
  await pool.query(
    "UPDATE edition_runs SET candidate_count=999,reason='后续另一次出刊记录' WHERE period_date='2026-10-22'",
  );
  const archived = await taskDetail('job:' + generation);
  assert.equal(archived?.edition.find((s) => s.section === '工具与开源')?.candidate_count, 1);
});
