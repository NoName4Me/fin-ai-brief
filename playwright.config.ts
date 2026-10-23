import { defineConfig } from '@playwright/test';
process.loadEnvFile('.env');
export default defineConfig({
  testDir: 'tests/browser',
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  use: {
    baseURL: process.env.TEST_BASE_URL ?? 'http://localhost:3100',
    headless: true,
    viewport: { width: 1440, height: 1000 },
  },
  reporter: 'list',
  outputDir: '.data/browser-results',
});
