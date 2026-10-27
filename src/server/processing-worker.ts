import type { PgBoss } from 'pg-boss';
import { getSettings } from './settings.ts';
import { executeTask } from './queue.ts';
import { processArticle } from './process.ts';

export function processingController(boss: PgBoss, run = processArticle) {
  let concurrency = 0;
  let configuring = false;
  return async function configureProcessing() {
    if (configuring) return;
    configuring = true;
    try {
      const config = await getSettings();
      if (config.processingConcurrency === concurrency) return;
      if (concurrency) await boss.offWork('process', { wait: true });
      await boss.work<{ id: string; reprocessBatchId?: string }>(
        'process',
        {
          localConcurrency: config.processingConcurrency,
          pollingIntervalSeconds: 1,
        },
        async ([job]) =>
          executeTask('process', job.id, job.data, () =>
            run(job.data.id, job.data.reprocessBatchId),
          ),
      );
      concurrency = config.processingConcurrency;
    } finally {
      configuring = false;
    }
  };
}
