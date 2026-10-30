import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/server/db.ts';
import { migrate } from '../scripts/migrate.ts';
import { saveSettings } from '../src/server/settings.ts';
import { defaultSettings } from '../src/server/types.ts';
import { fixtureContent } from './fixtures.ts';
import { dailyTitleRequest } from '../src/server/daily-title.ts';
import { reviseBriefTitle } from '../src/server/brief-title-revision.ts';
import { runtimeExceptions } from '../src/server/runtime-exceptions.ts';
import { publicationCycle } from '../src/server/periods.ts';

if (!/_test$/.test(new URL(process.env.DATABASE_URL!).pathname)) throw Error('必须使用_test数据库');
before(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE sources,articles,events,briefs,processing_steps,model_calls CASCADE');
  await saveSettings({ ...defaultSettings, briefTitleMaxLength: 30 });
});
after(() => pool.end());

test('标题拒绝定位式泛化主题与超限文字，接受具体主体和动作', () => {
  const request = dailyTitleRequest({}, 30);
  assert.equal(request.schema.safeParse({ title: 'AI治理与金融应用观察' }).success, false);
  assert.equal(request.schema.safeParse({ title: 'AI发展与治理进展' }).success, false);
  assert.equal(request.schema.safeParse({ title: '字'.repeat(31) }).success, false);
  assert.equal(
    request.schema.parse({ title: '金管局立规智能体；Anthropic披露研发自动化' }).title,
    '金管局立规智能体；Anthropic披露研发自动化',
  );
});

test('已发布期刊只修改标题，正文、待审稿、时间、期号及投递均不变，保留修订记录', async () => {
  const content = fixtureContent();
  const {
    rows: [before],
  } = await pool.query(
    `INSERT INTO briefs(kind,period_date,published,draft,generated_at,published_at,issue_number) VALUES('daily','2026-10-30',$1,$1,now(),now(),7) RETURNING *`,
    [JSON.stringify(content)],
  );
  await reviseBriefTitle(before.id, 'published', '金管局明确智能体责任边界');
  const {
    rows: [after],
  } = await pool.query('SELECT * FROM briefs WHERE id=$1', [before.id]);
  assert.deepEqual(after, {
    ...before,
    published: { ...content, title: '金管局明确智能体责任边界' },
  });
  assert.equal((await pool.query('SELECT count(*)::int n FROM deliveries')).rows[0].n, 0);
  assert.equal(
    (
      await pool.query(
        "SELECT result->>'before' title FROM processing_steps WHERE stage='title_revision'",
      )
    ).rows[0].title,
    content.title,
  );
});

test('标题生成期间原稿改变则拒绝覆盖', async () => {
  const {
    rows: [row],
  } = await pool.query(
    `INSERT INTO briefs(kind,period_date,published) VALUES('daily','2026-10-30',$1) RETURNING id`,
    [JSON.stringify(fixtureContent())],
  );
  Object.assign(process.env, {
    MODEL_CALLS_ENABLED: 'true',
    LLM_BASE_URL: 'https://model.invalid/v1',
    LLM_API_KEY: 'test-only',
    LLM_MODEL: 'test',
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    await pool.query(
      `UPDATE briefs SET published=jsonb_set(published,'{title}','"其他编辑的新标题"') WHERE id=$1`,
      [row.id],
    );
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ title: '金管局明确智能体责任边界' }) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    );
  };
  try {
    await assert.rejects(reviseBriefTitle(row.id, 'published'), /内容已变化/);
  } finally {
    globalThis.fetch = original;
  }
});

test('周期按配置的北京时间切分，实际发布不影响，旧问题仅在上一周期回顾', async () => {
  const now = new Date('2035-01-02T12:00:00Z');
  const publishedAt = new Date('2035-01-02T08:00:00Z');
  await pool.query(
    `INSERT INTO briefs(kind,period_date,published,published_at) VALUES('daily','2035-01-02',$1,$2)`,
    [JSON.stringify(fixtureContent()), publishedAt],
  );
  const source = randomUUID();
  await pool.query(
    `INSERT INTO sources(id,name,url,format,industry_id,enabled,last_error,last_fetched_at) VALUES($1,'上一周期失败','https://example.invalid','html','ai',true,'连接失败','2035-01-01T23:00:00Z')`,
    [source],
  );
  const article = randomUUID();
  await pool.query(
    `INSERT INTO articles(id,title,url,excerpt,published_at,source_name,industry_id,state,created_at) VALUES($1,'本轮失败','https://example.invalid/a','正文',now(),'来源','ai','failed','2035-01-02T09:00:00Z')`,
    [article],
  );
  for (const minute of [10, 20])
    await pool.query(
      `INSERT INTO processing_steps(subject,run_key,stage,state,started_at,finished_at) VALUES('brief:daily:2035-01-01',$1,'task','failed',$2,$2)`,
      [randomUUID(), `2035-01-01T23:${minute}:00Z`],
    );
  const result = await runtimeExceptions(now, '08:00');
  assert.equal(result.since.toISOString(), '2035-01-02T00:00:00.000Z');
  assert.deepEqual(
    [result.collection, result.processing, result.generation, result.total],
    [0, 1, 0, 1],
  );
  assert.deepEqual(
    [
      result.previous.collection,
      result.previous.processing,
      result.previous.generation,
      result.previous.total,
    ],
    [1, 0, 1, 2],
  );
  assert.equal(
    (await runtimeExceptions(new Date('2035-01-01T23:59:59Z'), '08:00')).since.toISOString(),
    '2035-01-01T00:00:00.000Z',
  );
  assert.equal(
    publicationCycle(new Date('2035-01-02T01:14:59Z'), '09:15').start.toISOString(),
    '2035-01-01T01:15:00.000Z',
  );
  assert.equal(
    publicationCycle(new Date('2035-01-02T01:15:00Z'), '09:15').start.toISOString(),
    '2035-01-02T01:15:00.000Z',
  );
});

test('本轮最新采集成功即恢复，不受失败次数影响；重试去重且跨周期不带入', async () => {
  const now = new Date('2035-01-02T12:00:00Z');
  const source = randomUUID();
  await pool.query(
    `INSERT INTO sources(id,name,url,format,industry_id,enabled,last_error,last_fetched_at,failure_count) VALUES($1,'当前失败','https://example.invalid','html','ai',true,'连接失败','2035-01-02T09:00:00Z',3)`,
    [source],
  );
  for (const minute of [10, 20])
    await pool.query(
      `INSERT INTO collection_runs(source_id,source_name,url,state,started_at,finished_at) VALUES($1,'来源','https://example.invalid','failed',$2,$2)`,
      [source, `2035-01-02T09:${minute}:00Z`],
    );
  assert.equal((await runtimeExceptions(now, '08:00')).collection, 1);
  await pool.query(
    `UPDATE sources SET last_error=NULL,last_fetched_at='2035-01-02T10:00:00Z' WHERE id=$1`,
    [source],
  );
  await pool.query(
    `INSERT INTO collection_runs(source_id,source_name,url,state,started_at,finished_at) VALUES($1,'来源','https://example.invalid','succeeded','2035-01-02T10:00:00Z','2035-01-02T10:00:00Z')`,
    [source],
  );
  assert.equal((await runtimeExceptions(now, '08:00')).collection, 0);
  const next = await runtimeExceptions(new Date('2035-01-03T00:00:00Z'), '08:00');
  assert.equal(next.collection, 0);
  assert.equal(next.previous.collection, 1);
});

test('本轮出刊失败重试仍计一项，成功后移除，旧的处理失败重试运行不伪装成本轮新异常', async () => {
  const now = new Date('2035-01-02T12:00:00Z');
  const article = randomUUID();
  await pool.query(
    `INSERT INTO articles(id,title,url,excerpt,published_at,source_name,industry_id,state,created_at) VALUES($1,'旧失败','https://example.invalid/a','正文',now(),'来源','ai','failed','2035-01-01T22:00:00Z')`,
    [article],
  );
  await pool.query(
    `INSERT INTO processing_steps(subject,run_key,stage,state,started_at,finished_at) VALUES($1,$2,'task','failed','2035-01-01T23:00:00Z','2035-01-01T23:00:00Z')`,
    [`article:${article}`, randomUUID()],
  );
  await pool.query(
    `INSERT INTO processing_steps(subject,run_key,stage,state,started_at) VALUES($1,$2,'task','running','2035-01-02T09:00:00Z')`,
    [`article:${article}`, randomUUID()],
  );
  for (const hour of [9, 10])
    await pool.query(
      `INSERT INTO processing_steps(subject,run_key,stage,state,started_at,finished_at) VALUES('brief:daily:2035-01-02',$1,'task','failed',$2,$2)`,
      [randomUUID(), `2035-01-02T${hour.toString().padStart(2, '0')}:00:00Z`],
    );
  const failed = await runtimeExceptions(now, '08:00');
  assert.equal(failed.processing, 0);
  assert.equal(failed.generation, 1);
  await pool.query(
    `INSERT INTO processing_steps(subject,run_key,stage,state,started_at,finished_at) VALUES('brief:daily:2035-01-02',$1,'task','succeeded','2035-01-02T11:00:00Z','2035-01-02T11:00:00Z')`,
    [randomUUID()],
  );
  assert.equal((await runtimeExceptions(now, '08:00')).generation, 0);
});
