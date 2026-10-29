import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { rankingItem } from '../../src/server/ranking-sources.ts';
import { localDate } from '../../src/server/periods.ts';
test('榜单快照可展开查看项目、名次和采集时间', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const id = randomUUID();
  const now = new Date();
  const item = rankingItem('GitHub Trending', {
    boardUrl: 'https://github.com/trending',
    observedAt: now.toISOString(),
    entries: [
      {
        key: '/org/alpha',
        name: 'org/alpha',
        url: 'https://github.com/org/alpha',
        rank: 1,
        metric: '100 stars today',
        description: 'AI coding tool',
      },
    ],
  });
  try {
    await db.query(
      "INSERT INTO sources(id,name,url,format,industry_id,verification_status) VALUES($1,'快照信源','https://github.com/trending','html','ai','approved')",
      [id],
    );
    await db.query(
      "INSERT INTO articles(source_id,source_name,url,title,excerpt,published_at,published_precision,provenance,industry_id) VALUES($1,'快照信源',$2,$3,$4,$5,'observed',$6,'ai')",
      [id, item.url, item.title, item.excerpt, now, JSON.stringify(item.provenance)],
    );
    await db.query(
      'INSERT INTO source_discoveries(source_id,url,title,published_at,first_seen_at,last_seen_at,inserted) VALUES($1,$2,$3,$4,$4,$4,true)',
      [id, item.url, item.title, now],
    );
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto(`/admin/sources/monitor?source=${id}&date=${localDate(now)}`);
    const table = page.getByRole('table', { name: '每日采集明细' });
    await expect(table.getByRole('columnheader', { name: '资讯时间', exact: true })).toBeVisible();
    await expect(table).toContainText('采集于');
    await table.getByText(item.title, { exact: true }).click();
    await expect(table.getByRole('link', { name: 'org/alpha', exact: true })).toBeVisible();
    await expect(table).toContainText('100 stars today');
    await expect(table).toContainText('首份快照，仅建立基线');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(table.getByRole('link', { name: 'org/alpha', exact: true })).toBeVisible();
  } finally {
    await db.query('DELETE FROM articles WHERE source_id=$1', [id]);
    await db.query('DELETE FROM sources WHERE id=$1', [id]);
    await db.end();
  }
});
