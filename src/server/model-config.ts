import { saveSettingsPatch } from './settings.ts';
import { getModelConnections, modelConfig } from './model.ts';
import { recordModelEvent } from './model-health.ts';
import { modelConnectionEntrySchema } from './types.ts';

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
export async function saveManagedModel(form: FormData) {
  const id = text(form, 'modelId') || crypto.randomUUID();
  let message = '';
  await saveSettingsPatch((current) => {
    const models = current.modelConnections;
    const existing = models.find((entry) => entry.id === id);
    const entry = modelConnectionEntrySchema.parse({
      id,
      name: text(form, 'modelDisplayName'),
      enabled: existing?.enabled ?? true,
      baseUrl: text(form, 'modelBaseUrl'),
      apiKey: text(form, 'modelApiKey') || existing?.apiKey || '',
      model: text(form, 'modelName'),
    });
    modelConfig(entry);
    if (models.some((item) => item.id !== id && item.name === entry.name))
      throw new Error('模型名称不能重复');
    const next = existing
      ? models.map((item) => (item.id === id ? entry : item))
      : [...models, entry];
    if (next.length > 10) throw new Error('最多配置10个模型');
    message = existing ? `更新「${entry.name}」配置` : `添加「${entry.name}」`;
    return { modelConnections: next };
  });
  await recordModelEvent('config-changed', id, message);
}

export async function toggleManagedModel(id: string, enabled: boolean) {
  let name = '';
  await saveSettingsPatch((current) => {
    const target = current.modelConnections.find((entry) => entry.id === id);
    if (!target) throw new Error('模型配置不存在');
    name = target.name;
    return {
      modelConnections: current.modelConnections.map((entry) =>
        entry.id === id ? { ...entry, enabled } : entry,
      ),
    };
  });
  await recordModelEvent('paused', id, enabled ? `启用「${name}」` : `暂停「${name}」`);
}

export async function setPrimaryModel(id: string) {
  let message = '';
  await saveSettingsPatch((current) => {
    const models = current.modelConnections;
    const target = models.find((entry) => entry.id === id);
    if (!target) throw new Error('模型配置不存在');
    if (!target.enabled) throw new Error('请先启用该模型，再设为主力');
    message = `切换主力：${models[0]?.name ?? '未设置'} → ${target.name}`;
    return { modelConnections: [target, ...models.filter((entry) => entry.id !== id)] };
  });
  await recordModelEvent('primary-changed', id, message);
}

export async function reorderManagedModels(ids: string[]) {
  await saveSettingsPatch((current) => {
    const models = current.modelConnections;
    const byId = new Map(models.map((entry) => [entry.id, entry]));
    if (
      ids.length !== models.length ||
      new Set(ids).size !== models.length ||
      ids.some((id) => !byId.has(id))
    )
      throw new Error('备用模型顺序无效');
    if (models[0] && ids[0] !== models[0].id) throw new Error('主力模型固定在首位');
    return { modelConnections: ids.map((id) => byId.get(id)!) };
  });
}

export async function removeManagedModel(id: string) {
  let name = '';
  await saveSettingsPatch((current) => {
    const target = current.modelConnections.find((entry) => entry.id === id);
    if (!target) throw new Error('模型配置不存在');
    name = target.name;
    const next = current.modelConnections.filter((entry) => entry.id !== id);
    return { modelConnections: next, ...(!next.length ? { modelSchedulingEnabled: false } : {}) };
  });
  await recordModelEvent('config-changed', id, `移除「${name}」`);
}

export async function testManagedModel(id: string, fetcher: typeof fetch = fetch) {
  const model = (await getModelConnections()).find((entry) => entry.id === id);
  if (!model) throw new Error('模型配置不存在');
  const form = new FormData();
  form.set('modelCallsEnabled', 'true');
  form.set('modelBaseUrl', model.baseUrl);
  form.set('modelName', model.model);
  form.set('modelApiKey', model.apiKey);
  form.set('modelConfigId', model.id);
  form.set('modelDisplayName', model.name);
  const { testModelConnection } = await import('./system-settings.ts');
  return testModelConnection(form, fetcher);
}
