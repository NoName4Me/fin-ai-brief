import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { z } from 'zod';
import { migrate } from '../scripts/migrate.ts';
import { pool } from '../src/server/db.ts';
import { saveSettings } from '../src/server/settings.ts';
import { defaultSettings } from '../src/server/types.ts';
import { modelJSON, probeUnavailableModels } from '../src/server/model.ts';

if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('必须使用独立_test数据库');

let primaryHealthy = false;
let primaryRequests = 0;
let backupRequests = 0;
let baseUrl = '';
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  assert.match(body, /"model":"(primary|backup)-model"/);
  if (request.url?.startsWith('/primary/')) {
    primaryRequests++;
    if (!primaryHealthy) {
      response.writeHead(503).end('unavailable');
      return;
    }
  } else {
    backupRequests++;
  }
  response.setHeader('Content-Type', 'application/json');
  response.end(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }),
  );
});

before(async () => {
  await migrate();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务未启动');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  primaryHealthy = false;
  primaryRequests = 0;
  backupRequests = 0;
  await pool.query(
    `TRUNCATE model_calls,model_health,model_events,model_routing CASCADE;
     INSERT INTO model_routing(id) VALUES(1);`,
  );
  await saveSettings({
    ...defaultSettings,
    modelConnections: [
      {
        id: 'primary',
        name: '主力模型',
        enabled: true,
        baseUrl: `${baseUrl}/primary/v1`,
        apiKey: 'primary-key',
        model: 'primary-model',
      },
      {
        id: 'backup',
        name: '备用模型',
        enabled: true,
        baseUrl: `${baseUrl}/backup/v1`,
        apiKey: 'backup-key',
        model: 'backup-model',
      },
    ],
    modelConnection: undefined,
    modelSchedulingEnabled: true,
    modelDailyLimit: 100,
  });
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test('主力失败时当前请求切备用，三次后冷却，两轮探测成功后回切', async () => {
  const schema = z.object({ ok: z.boolean() });
  for (let index = 0; index < 3; index++)
    assert.deepEqual(await modelJSON('test', 'prompt', { index }, schema), { ok: true });
  assert.equal(primaryRequests, 3);
  assert.equal(backupRequests, 3);

  assert.deepEqual(await modelJSON('test', 'prompt', { index: 3 }, schema), { ok: true });
  assert.equal(primaryRequests, 3);
  assert.equal(backupRequests, 4);

  const health = (
    await pool.query(
      'SELECT model_config_id,state,consecutive_failures FROM model_health ORDER BY model_config_id',
    )
  ).rows;
  assert.deepEqual(health, [
    { model_config_id: 'backup', state: 'healthy', consecutive_failures: 0 },
    { model_config_id: 'primary', state: 'unavailable', consecutive_failures: 3 },
  ]);
  const attempts = await pool.query(
    'SELECT model_config_id,state FROM model_attempts WHERE call_id=(SELECT id FROM model_calls ORDER BY created_at DESC LIMIT 1) ORDER BY attempt',
  );
  assert.deepEqual(attempts.rows, [{ model_config_id: 'backup', state: 'succeeded' }]);

  await pool.query(
    "UPDATE model_health SET cooldown_until=now()-interval '1 second' WHERE model_config_id='primary'",
  );
  await modelJSON('test', 'prompt', { index: 'expired-cooldown' }, schema);
  assert.equal(primaryRequests, 3);
  primaryHealthy = true;
  const firstProbeAt = new Date(Date.now() + 6 * 60_000);
  assert.deepEqual((await probeUnavailableModels(fetch, firstProbeAt))[0], {
    modelId: 'primary',
    ok: true,
    recovered: false,
  });
  await modelJSON('test', 'prompt', { index: 'between-probes' }, schema);
  assert.equal(primaryRequests, 4);
  const secondProbeAt = new Date(firstProbeAt.getTime() + 3 * 60_000);
  assert.deepEqual((await probeUnavailableModels(fetch, secondProbeAt))[0], {
    modelId: 'primary',
    ok: true,
    recovered: true,
  });

  assert.deepEqual(await modelJSON('test', 'prompt', { index: 4 }, schema), { ok: true });
  assert.equal(primaryRequests, 6);
  const events = await pool.query(
    'SELECT event_type,message FROM model_events ORDER BY created_at,id',
  );
  assert.ok(
    events.rows.some(
      (row) =>
        row.event_type === 'fallback' && row.message === '主力模型 服务端错误，主力模型 → 备用模型',
    ),
  );
  assert.ok(
    events.rows.some(
      (row) =>
        row.event_type === 'recovered' &&
        row.message === '主模型 主力模型 恢复，备用模型 → 主力模型',
    ),
  );
});

test('清空模型后即使环境变量开启也不恢复隐式调用', async () => {
  const { removeManagedModel } = await import('../src/server/model-config.ts');
  const { getModelConnection } = await import('../src/server/model.ts');
  const { getSettings } = await import('../src/server/settings.ts');
  const original = process.env.MODEL_CALLS_ENABLED;
  try {
    process.env.MODEL_CALLS_ENABLED = 'true';
    await removeManagedModel('backup');
    await removeManagedModel('primary');
    await migrate(); // Restart/deploy migration must not re-import an environment model.
    assert.equal((await getModelConnection()).enabled, false);
    assert.equal((await getSettings()).modelSchedulingEnabled, false);
    await assert.rejects(
      modelJSON('test', 'prompt', {}, z.object({ ok: z.boolean() })),
      /启用至少一个模型/,
    );
  } finally {
    if (original === undefined) delete process.env.MODEL_CALLS_ENABLED;
    else process.env.MODEL_CALLS_ENABLED = original;
  }
});

test('关闭调度不执行恢复探测', async () => {
  const { saveSettingsPatch } = await import('../src/server/settings.ts');
  await saveSettingsPatch({ modelSchedulingEnabled: false });
  await pool.query(
    "INSERT INTO model_health(model_config_id,state) VALUES('primary','unavailable')",
  );
  assert.deepEqual(await probeUnavailableModels(), []);
  assert.equal(primaryRequests, 0);
});

test('关闭调度后已排队的模型任务等待且不执行', async () => {
  const { saveSettingsPatch } = await import('../src/server/settings.ts');
  const { executeTask } = await import('../src/server/queue.ts');
  await saveSettingsPatch({ modelSchedulingEnabled: false });
  let called = false;
  const result = await executeTask(
    'process',
    crypto.randomUUID(),
    { id: crypto.randomUUID() },
    async () => {
      called = true;
    },
  );
  assert.equal(called, false);
  assert.deepEqual(result, { waitingBudget: true });
});
