import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

test('首页展示运行总览，出刊管理独立，手机无横向溢出', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const sourceId = randomUUID();
  try {
    await db.query(
      `INSERT INTO sources(id,name,url,format,industry_id,enabled,last_fetched_at,failure_count,last_error)
      VALUES($1,'连续失败信源','https://example.invalid/overview','rss','ai',true,now(),3,'连接超时')`,
      [sourceId],
    );
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: '数据总览', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '今日出刊', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '生成前检查' })).toHaveCount(0);
    await expect(page.locator('.overview-source-numbers')).toContainText('1异常');
    await expect(page.getByRole('heading', { name: '信源运行', exact: true })).toHaveCount(0);
    await expect(page.getByText('正常留空 0', { exact: true })).toBeVisible();
    await expect(page.getByText('未排期 1', { exact: true })).toBeVisible();
    await page.screenshot({ path: '.data/admin-overview-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: '.data/admin-overview-mobile.png', fullPage: true });
    await page
      .getByRole('navigation', { name: '管理导航' })
      .getByRole('link', { name: '出刊管理', exact: true })
      .click();
    await expect(page).toHaveURL(/\/admin\/publications$/);
    await expect(page.getByRole('button', { name: '生成前检查' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'AI治理与工具进展' })).toBeVisible();
    await page.goto('/admin/editorial/content');
    await expect(page.locator('textarea[name="tags"]')).toHaveCount(0);
    await expect(page.getByLabel('收录与写作要求', { exact: true })).toBeVisible();
  } finally {
    await db.query('DELETE FROM sources WHERE id=$1', [sourceId]);
    await db.end();
  }
});
