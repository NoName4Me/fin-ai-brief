import { getSettings, saveSettings } from '../src/server/settings.ts';
import { enqueuePendingArticles } from '../src/server/queue.ts';

export async function enqueueScreenedArticles() {
  const config = await getSettings();
  const originalFetch = globalThis.fetch;
  await saveSettings({
    ...config,
    modelConnection: {
      enabled: true,
      baseUrl: 'https://screen.invalid/v1',
      apiKey: 'test-only',
      model: 'test',
    },
  });
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                results: input.articles.map((a: { id: string }) => ({
                  id: a.id,
                  decision: 'PASS',
                  reason: '相关',
                })),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  };
  try {
    await enqueuePendingArticles();
  } finally {
    globalThis.fetch = originalFetch;
    await saveSettings(config);
  }
}
