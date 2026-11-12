import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../scripts/migrate.ts';
import { pool } from '../src/server/db.ts';
import { getSettings, saveSettings, saveSettingsPatch } from '../src/server/settings.ts';
import { defaultSettings } from '../src/server/types.ts';
import { requireModelConfig, inspectModelRequest, modelUsage } from '../src/server/model.ts';
import { saveSystemSettings, testModelConnection } from '../src/server/system-settings.ts';

if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('必须使用独立_test数据库');
const connection = {
  enabled: true,
  baseUrl: 'https://saved.invalid/v1',
  apiKey: 'stored-test-key',
  model: 'saved-model',
};
before(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE model_calls,processing_steps CASCADE');
  await saveSettings({ ...defaultSettings, modelConnection: connection });
});
after(() => pool.end());
function form() {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    modelCallsEnabled: 'true',
    modelBaseUrl: connection.baseUrl,
    modelName: connection.model,
    modelApiKey: '',
    modelDailyLimit: '123',
    retentionEnabled: 'true',
    newsRetentionDays: '99',
    taskRetentionDays: '20',
    mailRetentionDays: '8',
  }))
    data.set(key, value);
  return data;
}
test('模型运行与预览读取已保存配置，迁移不覆盖管理员修改', async () => {
  assert.deepEqual(await requireModelConfig(), {
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    model: connection.model,
  });
  assert.equal((await getSettings()).modelOffPeakOnly, true);
  const first = await inspectModelRequest('brief', 'prompt', {}, 12000);
  await saveSettingsPatch({
    modelConnection: { ...connection, baseUrl: 'https://changed.invalid/v1' },
  });
  const second = await inspectModelRequest('brief', 'prompt', {}, 12000);
  assert.equal(first.model, connection.model);
  assert.notEqual(first.key, second.key);
  await migrate();
  assert.equal((await requireModelConfig()).baseUrl, 'https://changed.invalid/v1');
  await saveSettingsPatch({ modelConnection: { ...connection, enabled: false } });
  await assert.rejects(requireModelConfig(), /开启模型调用/);
});
test('统一保存模型和清理设置，密钥留空保留，其他设置不受影响', async () => {
  await saveSystemSettings(form());
  const saved = await getSettings();
  assert.equal(saved.modelDailyLimit, 123);
  assert.equal(saved.modelOffPeakOnly, false);
  assert.equal(saved.newsRetentionDays, 99);
  assert.equal(saved.taskRetentionDays, 20);
  assert.equal(saved.mailRetentionDays, 8);
  assert.equal(saved.modelConnection?.apiKey, connection.apiKey);
  assert.equal(saved.processingConcurrency, defaultSettings.processingConcurrency);
  const next = form();
  next.set('modelOffPeakOnly', 'on');
  next.set('modelApiKey', 'replacement-test-key');
  await saveSystemSettings(next);
  assert.equal((await requireModelConfig()).apiKey, 'replacement-test-key');
  assert.equal((await getSettings()).modelOffPeakOnly, true);
});
test('配置无效时整次保存拒绝，不部分覆盖额度或数据保留', async () => {
  const data = form();
  data.set('modelBaseUrl', 'file:///tmp/key');
  await assert.rejects(saveSystemSettings(data), /API/);
  const saved = await getSettings();
  assert.equal(saved.modelDailyLimit, defaultSettings.modelDailyLimit);
  assert.deepEqual(saved.modelConnection, connection);
});
test('连通测试发送当前表单的test，不修改已保存配置，成功和失败都计额度', async () => {
  const data = form();
  data.set('modelName', 'unsaved-model');
  data.set('modelBaseUrl', 'https://temporary.invalid/v1');
  const result = await testModelConnection(data, async (url, init) => {
    assert.equal(url, 'https://temporary.invalid/v1/chat/completions');
    assert.deepEqual(JSON.parse(String(init?.body)).messages, [{ role: 'user', content: 'test' }]);
    assert.equal(JSON.parse(String(init?.body)).model, 'unsaved-model');
    return Response.json({
      choices: [{ message: { content: 'test received' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
  });
  assert.equal(result, 'test received');
  assert.deepEqual((await getSettings()).modelConnection, connection);
  assert.equal((await modelUsage()).used, 1);
  await assert.rejects(
    testModelConnection(data, async () => new Response('', { status: 401 })),
    /HTTP 401/,
  );
  assert.equal((await modelUsage()).used, 2);
  const logs = (
    await pool.query(
      "SELECT state,error,input_summary,response FROM model_calls WHERE purpose='connection-test' ORDER BY created_at",
    )
  ).rows;
  assert.deepEqual(
    logs.map((row) => row.state),
    ['succeeded', 'failed'],
  );
  assert.doesNotMatch(JSON.stringify(logs), /stored-test-key/);
  await saveSettingsPatch({ modelDailyLimit: 2 });
  await assert.rejects(
    testModelConnection(data, async () => {
      throw new Error('不应调用');
    }),
    /已达上限/,
  );
});
