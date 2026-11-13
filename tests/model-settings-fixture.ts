import { getSettings, saveSettings as persistSettings } from '../src/server/settings.ts';

// Older scenario tests configured their fake provider through environment variables.
// Import that fake provider explicitly into managed settings; production no longer
// falls back to the environment after a model list is cleared.
export async function saveSettings(input: unknown) {
  const value = input as Record<string, unknown>;
  const models = value.modelConnections as unknown[] | undefined;
  await persistSettings({
    ...value,
    ...(!models?.length && !value.modelConnection
      ? {
          modelConnection: {
            enabled: process.env.MODEL_CALLS_ENABLED !== 'false',
            baseUrl: process.env.LLM_BASE_URL ?? 'http://model.invalid/v1',
            apiKey: process.env.LLM_API_KEY ?? 'test-only',
            model: process.env.LLM_MODEL ?? 'test',
          },
        }
      : {}),
    modelSchedulingEnabled: true,
  });
}
export async function syncModelSettings() {
  const current = await getSettings();
  await persistSettings({
    ...current,
    modelConnection: {
      enabled: process.env.MODEL_CALLS_ENABLED !== 'false',
      baseUrl: process.env.LLM_BASE_URL ?? 'http://model.invalid/v1',
      apiKey: process.env.LLM_API_KEY ?? 'test-only',
      model: process.env.LLM_MODEL ?? 'test',
    },
    modelSchedulingEnabled: true,
  });
}
