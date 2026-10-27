import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
process.loadEnvFile('.env');
Object.assign(process.env, parseEnv(readFileSync('.data/test.env', 'utf8')));
export default defineConfig({
  globalSetup: './tests/browser/setup.ts',
  testDir: 'tests/browser',
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  use: {
    baseURL: process.env.TEST_BASE_URL ?? 'http://localhost:3101',
    headless: true,
    viewport: { width: 1440, height: 1000 },
  },
  reporter: 'list',
  outputDir: '.data/browser-results',
  webServer: {
    command: 'node_modules/.bin/next dev -p 3101',
    url: 'http://localhost:3101',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      MODEL_CALLS_ENABLED: 'false',
      MAIL_ENABLED: 'false',
      NEXT_DIST_DIR: '.data/next-browser',
    },
  },
});
