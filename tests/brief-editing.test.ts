import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/server/db.ts';
import { migrate } from '../scripts/migrate.ts';
import { fixtureContent } from './fixtures.ts';
import { defaultSettings } from '../src/server/types.ts';
import { saveSettings, getSettings, saveEditorialConfig } from '../src/server/settings.ts';
import { saveBriefEdit, rewriteBriefField, revisionVersion } from '../src/server/brief-editing.ts';
import { defaultTitlePrompt } from '../src/server/title-writing.ts';
import { replaceField } from '../src/server/brief-edit-fields.ts';
import { renderEmail } from '../src/server/mail-template.ts';
import { dailyTitleRequest } from '../src/server/daily-title.ts';
if (!/_test$/.test(new URL(process.env.DATABASE_URL!).pathname)) throw Error('必须使用_test数据库');
before(migrate);
beforeEach(async () => {
  await pool.query(
    'TRUNCATE briefs,articles,events,model_calls,processing_steps,subscriptions CASCADE',
  );
  await saveSettings({ ...defaultSettings, autoPublish: false });
});
after(() => pool.end());
async function issue() {
  return (
    await pool.query(
      `INSERT INTO briefs(kind,period_date,published,published_at,generated_at,issue_number) VALUES('daily','2026-10-22',$1,now(),now(),9) RETURNING *`,
      [JSON.stringify(fixtureContent())],
    )
  ).rows[0];
}

test('标题要求兼容旧配置，分页面保存保留要求且共用生成请求', async () => {
  const { briefTitlePrompt: _, ...old } = defaultSettings;
  await saveSettings(old);
  assert.equal((await getSettings()).briefTitlePrompt, defaultTitlePrompt);
  await saveEditorialConfig({ briefTitlePrompt: '只写本期具体机构及其动作' });
  await saveEditorialConfig({ candidateRating: 3.7 });
  const c = await getSettings();
  assert.equal(c.briefTitlePrompt, '只写本期具体机构及其动作');
  assert.match(
    dailyTitleRequest({}, c.briefTitleMaxLength, c.briefTitlePrompt).system,
    /只写本期具体机构及其动作/,
  );
});
test('全文修订先保存草稿，更新正式版保留时间、正文关联与期号，并记录前后版本', async () => {
  const row = await issue(),
    content = structuredClone(row.published);
  content.title = '金管局明确智能体责任边界';
  content.items[0].summary = '人工修订后的事实摘要。';
  content.overview.finance = '人工修改的行业概览';
  content.note = '人工备注';
  const result = await saveBriefEdit({
    id: row.id,
    version: revisionVersion(row),
    base: 'published',
    content,
  });
  let saved = (await pool.query('SELECT * FROM briefs WHERE id=$1', [row.id])).rows[0];
  assert.deepEqual(saved.published, row.published);
  assert.deepEqual(saved.draft, content);
  await saveBriefEdit({ id: row.id, version: result.version, base: 'draft', content }, true);
  saved = (await pool.query('SELECT * FROM briefs WHERE id=$1', [row.id])).rows[0];
  assert.deepEqual(saved.published, content);
  assert.equal(saved.draft, null);
  assert.equal(saved.published_at.toISOString(), row.published_at.toISOString());
  assert.equal(saved.generated_at.toISOString(), row.generated_at.toISOString());
  assert.equal(saved.issue_number, 9);
  assert.equal((await pool.query('SELECT count(*)::int n FROM deliveries')).rows[0].n, 0);
  const audit = (
    await pool.query(
      "SELECT result FROM processing_steps WHERE stage='revision' ORDER BY finished_at",
    )
  ).rows;
  assert.equal(audit.length, 2);
  assert.deepEqual(audit[1].result.after, content);
});
test('拒绝过期编辑与事件来源篡改，草稿可保存超预算标题但发布必须校验', async () => {
  const row = await issue(),
    content = structuredClone(row.published),
    req = { id: row.id, version: revisionVersion(row), base: 'published', content };
  const tampered = structuredClone(req);
  tampered.content.items[0].eventId = randomUUID();
  await assert.rejects(saveBriefEdit(tampered), /事件、来源/);
  content.title = '字'.repeat(37);
  const saved = await saveBriefEdit(req);
  await assert.rejects(saveBriefEdit(req), /期刊已被更新/);
  await assert.rejects(
    saveBriefEdit({ ...req, version: saved.version, base: 'draft' }, true),
    /不能超过36字/,
  );
  assert.equal(
    (await pool.query('SELECT published FROM briefs WHERE id=$1', [row.id])).rows[0].published
      .title,
    row.published.title,
  );
});
test('逐字段AI读取当前编辑稿和原始材料，只返回候选不修改期刊', async () => {
  const row = await issue(),
    content = structuredClone(row.published);
  content.items[0].summary = '用户尚未保存的措辞';
  await pool.query(
    `INSERT INTO articles(title,url,excerpt,published_at,source_name,industry_id,state) VALUES('原始标题',$1,'机构已发布治理规则，明确人工复核责任。','2026-10-21T12:00:00Z','官方','ai','processed')`,
    [content.items[0].sources[0].url],
  );
  Object.assign(process.env, {
    MODEL_CALLS_ENABLED: 'true',
    LLM_BASE_URL: 'https://model.invalid/v1',
    LLM_API_KEY: 'test-only',
    LLM_MODEL: 'test',
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const input = JSON.parse(body.messages[1].content);
    assert.equal(input.current, '用户尚未保存的措辞');
    assert.match(input.material[0].excerpt, /人工复核责任/);
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ text: '机构发布治理规则，明确人工复核责任。' }) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    );
  };
  try {
    const text = await rewriteBriefField(
      { id: row.id, version: revisionVersion(row), base: 'published', content },
      { kind: 'itemSummary', index: 0 },
    );
    assert.match(text, /人工复核责任/);
    assert.deepEqual(
      (await pool.query('SELECT published,draft FROM briefs WHERE id=$1', [row.id])).rows[0],
      { published: row.published, draft: null },
    );
  } finally {
    globalThis.fetch = original;
  }
  await assert.rejects(
    rewriteBriefField(
      { id: row.id, version: revisionVersion(row), base: 'published', content },
      { kind: 'itemSummary', index: 99 },
    ),
    /字段不存在/,
  );
});

test('栏目名在成稿编辑中保持固定，历史显示名仍正确呈现', async () => {
  const row = await issue();
  const content = structuredClone(row.published);
  content.rotations = [
    {
      name: '一周观察',
      displayName: '本周工程观察',
      text: '本周部署治理更强调责任边界。',
      sources: content.items[0].sources,
    },
  ];
  content.highlightsTitle = '今日要览';
  await pool.query('UPDATE briefs SET published=$2 WHERE id=$1', [row.id, JSON.stringify(content)]);
  const version = revisionVersion({ ...row, published: content });
  const req = { id: row.id, version, base: 'published', content };
  await assert.rejects(
    saveBriefEdit({
      ...req,
      content: replaceField(content, { kind: 'rotationName', index: 0 }, '另一个名称'),
    }),
    /栏目名称/,
  );
  await assert.rejects(
    saveBriefEdit({ ...req, content: { ...content, highlightsTitle: '更改要览' } }),
    /栏目名称/,
  );
  await assert.rejects(rewriteBriefField(req, { kind: 'rotationName', index: 0 }), /栏目名称/);
  assert.match(
    renderEmail(content, 'https://example.invalid/issue', 'https://example.invalid/unsubscribe'),
    /本周工程观察/,
  );
});

test('手动重复重写相同字段每次请求模型，不复用成功缓存，并携带最近候选', async () => {
  const row = await issue();
  Object.assign(process.env, {
    MODEL_CALLS_ENABLED: 'true',
    LLM_BASE_URL: 'https://model.invalid/v1',
    LLM_API_KEY: 'test-only',
    LLM_MODEL: 'test',
  });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    const input = JSON.parse(body.messages[1].content);
    if (calls === 3) assert.deepEqual(input.previousCandidates, ['机构发布治理规则']);
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                title: calls === 1 ? '机构发布治理规则' : '机构明确人工复核责任',
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    );
  };
  try {
    const req = {
      id: row.id,
      version: revisionVersion(row),
      base: 'published',
      content: row.published,
    };
    await rewriteBriefField(req, { kind: 'title' });
    await rewriteBriefField(req, { kind: 'title' });
    await rewriteBriefField(req, { kind: 'title' }, ['机构发布治理规则']);
    assert.equal(calls, 3);
    const logs = (await pool.query('SELECT reused_count FROM model_calls')).rows;
    assert.equal(logs.length, 3);
    assert.ok(logs.every((r) => r.reused_count === 0));
  } finally {
    globalThis.fetch = original;
  }
});
