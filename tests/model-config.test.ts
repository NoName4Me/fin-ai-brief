import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../scripts/migrate.ts';
import { pool } from '../src/server/db.ts';
import { getSettings, saveSettings } from '../src/server/settings.ts';
import { defaultSettings } from '../src/server/types.ts';
import { describeModelOverviewStatus } from '../src/server/admin-models.ts';
import {
  removeManagedModel,
  reorderManagedModels,
  saveManagedModel,
  setPrimaryModel,
  toggleManagedModel,
} from '../src/server/model-config.ts';

if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('必须使用独立_test数据库');
before(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE model_events');
  await saveSettings({ ...defaultSettings, modelConnections: [], modelConnection: undefined });
});
after(() => pool.end());

function modelForm(values: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
}

test('总览模型状态明确区分主力正常、备用接管和主备不可用', () => {
  assert.deepEqual(
    describeModelOverviewStatus({
      status: 'healthy',
      enabledCount: 2,
      usableCount: 2,
      currentName: '主力模型',
      primaryName: '主力模型',
    }),
    { label: '主力正常', detail: '当前主力 主力模型' },
  );
  assert.deepEqual(
    describeModelOverviewStatus({
      status: 'fallback',
      enabledCount: 2,
      usableCount: 1,
      currentName: '备用模型',
      primaryName: '主力模型',
    }),
    {
      label: '主力异常，备用接管',
      detail: '备用 备用模型 接管，主力 主力模型 异常',
    },
  );
  assert.deepEqual(
    describeModelOverviewStatus({
      status: 'unavailable',
      enabledCount: 2,
      usableCount: 0,
      currentName: '主力模型',
      primaryName: '主力模型',
    }),
    { label: '主备均不可用', detail: '已启用 2 个模型，可用 0 个' },
  );
});

test('模型可新增、启停、切换主力并按配置顺序保留备用', async () => {
  await saveManagedModel(
    modelForm({
      modelId: 'primary',
      modelDisplayName: '主力模型',
      modelBaseUrl: 'https://primary.example/v1',
      modelApiKey: 'primary-key',
      modelName: 'model-a',
    }),
  );
  await saveManagedModel(
    modelForm({
      modelId: 'backup',
      modelDisplayName: '备用模型',
      modelBaseUrl: 'https://backup.example/v1',
      modelApiKey: 'backup-key',
      modelName: 'model-b',
    }),
  );
  assert.deepEqual(
    (await getSettings()).modelConnections.map(({ id, enabled }) => ({ id, enabled })),
    [
      { id: 'primary', enabled: true },
      { id: 'backup', enabled: true },
    ],
  );
  await toggleManagedModel('primary', false);
  assert.equal((await getSettings()).modelConnections[0].enabled, false);
  await saveManagedModel(
    modelForm({
      modelId: 'primary',
      modelDisplayName: '主力模型',
      modelBaseUrl: 'https://primary.example/v1',
      modelName: 'model-a-updated',
    }),
  );
  assert.equal((await getSettings()).modelConnections[0].enabled, false);
  await toggleManagedModel('primary', true);
  await setPrimaryModel('backup');
  assert.deepEqual(
    (await getSettings()).modelConnections.map((model) => model.id),
    ['backup', 'primary'],
  );
  await removeManagedModel('primary');
  assert.deepEqual(
    (await getSettings()).modelConnections.map((model) => model.id),
    ['backup'],
  );
  const events = await pool.query('SELECT event_type FROM model_events ORDER BY id');
  assert.ok(events.rows.some((row) => row.event_type === 'paused'));
  assert.ok(events.rows.some((row) => row.event_type === 'primary-changed'));
});

test('主力固定在首位，备用模型可以调整顺序', async () => {
  for (const [id, name] of [
    ['primary', '主力模型'],
    ['backup-a', '备用模型 A'],
    ['backup-b', '备用模型 B'],
  ])
    await saveManagedModel(
      modelForm({
        modelId: id,
        modelDisplayName: name,
        modelBaseUrl: `https://${id}.example/v1`,
        modelApiKey: `${id}-key`,
        modelName: `${id}-model`,
      }),
    );

  await reorderManagedModels(['primary', 'backup-b', 'backup-a']);
  assert.deepEqual(
    (await getSettings()).modelConnections.map((model) => model.id),
    ['primary', 'backup-b', 'backup-a'],
  );
  await assert.rejects(() => reorderManagedModels(['backup-b', 'primary', 'backup-a']), {
    message: '主力模型固定在首位',
  });
});

test('并发暂停与编辑不会互相覆盖，清空自动关闭调度', async () => {
  const add = (name: string) =>
    saveManagedModel(
      modelForm({
        modelId: name,
        modelDisplayName: name,
        modelBaseUrl: 'https://example.com/v1',
        modelApiKey: 'test',
        modelName: name,
      }),
    );
  await add('primary');
  await add('backup');
  const { saveSettingsPatch } = await import('../src/server/settings.ts');
  await saveSettingsPatch({ modelSchedulingEnabled: true });
  await Promise.all([toggleManagedModel('backup', false), add('primary')]);
  assert.equal(
    (await getSettings()).modelConnections.find((m) => m.id === 'backup')?.enabled,
    false,
  );
  await Promise.all([removeManagedModel('primary'), removeManagedModel('backup')]);
  assert.deepEqual((await getSettings()).modelConnections, []);
  assert.equal((await getSettings()).modelSchedulingEnabled, false);
  await add('new');
  assert.equal((await getSettings()).modelSchedulingEnabled, false);
});

test('总览按当前可用顺序展示模型，不沿用已暂停或被移除的历史路由', async () => {
  await pool.query('TRUNCATE model_health,model_routing');
  const add = (id: string) =>
    saveManagedModel(
      modelForm({
        modelId: id,
        modelDisplayName: id,
        modelBaseUrl: 'https://example.com/v1',
        modelApiKey: 'test',
        modelName: id,
      }),
    );
  await add('route-primary');
  await add('route-backup');
  const { getModelManagement } = await import('../src/server/admin-models.ts');
  await pool.query(
    "INSERT INTO model_routing(id,current_model_config_id,current_model_healthy) VALUES(1,'route-primary',true)",
  );
  await toggleManagedModel('route-primary', false);
  assert.equal((await getModelManagement()).currentModelId, 'route-backup');
  await toggleManagedModel('route-primary', true);
  await setPrimaryModel('route-backup');
  assert.equal((await getModelManagement()).currentModelId, 'route-backup');
  await removeManagedModel('route-backup');
  assert.equal((await getModelManagement()).currentModelId, 'route-primary');
  await toggleManagedModel('route-primary', false);
  assert.equal((await getModelManagement()).currentModelId, null);
});
