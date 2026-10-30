import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { publicationCycle } from '../../src/server/periods.ts';

test('首页展示运行总览，出刊管理独立，手机无横向溢出', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const sourceId = randomUUID();
  const olderSourceId = randomUUID();
  const cycleStart = publicationCycle(new Date(), '08:00').start;
  try {
    await db.query(
      `INSERT INTO sources(id,name,url,format,industry_id,enabled,last_fetched_at,failure_count,last_error)
      VALUES($1,'连续失败信源','https://example.invalid/overview','rss','ai',true,now(),3,'连接超时')`,
      [sourceId],
    );
    await db.query(
      `INSERT INTO sources(id,name,url,format,industry_id,enabled,last_fetched_at,failure_count,last_error) VALUES($1,'上一期失败信源','https://example.invalid/older','rss','ai',true,$2,3,'旧错误')`,
      [olderSourceId, new Date(cycleStart.getTime() - 1000)],
    );
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: '数据总览', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '本期出刊', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '生成前检查' })).toHaveCount(0);
    const collection = page.getByRole('region', { name: '本轮采集', exact: true });
    await expect(collection.getByText('当前异常信源', { exact: true }).locator('..')).toContainText(
      '1个',
    );
    await expect(page.getByText('待处理事项', { exact: true })).toHaveCount(0);
    await expect(page.getByText('运行异常', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '待办全部积压' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '信源运行', exact: true })).toHaveCount(0);
    await expect(page.getByText('正常留空 0', { exact: true })).toBeVisible();
    await expect(page.getByText('未排期 1', { exact: true })).toBeVisible();
    await page.screenshot({ path: '.data/admin-overview-desktop.png', fullPage: true });
    await collection.getByRole('link', { name: '1个', exact: true }).click();
    await expect(page.getByLabel('质量状态')).toHaveValue('cycle_error');
    await expect(page.getByRole('row').filter({ hasText: '连续失败信源' })).toHaveCount(1);
    await expect(page.getByRole('row').filter({ hasText: '上一期失败信源' })).toHaveCount(0);
    await db.query('UPDATE sources SET last_error=NULL WHERE id=$1', [sourceId]);
    await page.goto('/admin');
    await expect(collection.getByText('当前异常信源', { exact: true }).locator('..')).toContainText(
      '0个',
    );
    await page.getByRole('link', { name: '近7天', exact: true }).click();
    await expect(page.getByRole('heading', { name: '内容转化', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '订阅趋势', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '栏目表现', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '近30天', exact: true }).click();
    await expect(page).toHaveURL(/view=30/);
    await expect(page.getByRole('heading', { name: '信源有效贡献 Top 5' })).toBeVisible();
    await page.getByRole('link', { name: '今日', exact: true }).click();
    await expect(page.getByRole('heading', { name: '本轮采集', exact: true })).toBeVisible();
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
    await expect(page.getByRole('link', { name: '手动补刊', exact: true })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'AI治理与工具进展' })).toBeVisible();
    await page.goto('/admin/editorial/content');
    await expect(page.locator('textarea[name="tags"]')).toHaveCount(0);
    await expect(page.getByLabel('收录与写作要求', { exact: true })).toBeVisible();
  } finally {
    await db.query('DELETE FROM sources WHERE id=ANY($1::uuid[])', [[sourceId, olderSourceId]]);
    await db.end();
  }
});
