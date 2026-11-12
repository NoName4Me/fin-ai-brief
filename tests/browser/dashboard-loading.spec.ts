import { test, expect } from '@playwright/test';
import { Pool } from 'pg';

test('趋势内容查询阻塞时，周期立即切换，订阅和栏目独立加载', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const blocker = await db.connect();
  try {
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: '本轮采集', exact: true })).toBeVisible();

    // Hold just the content-statistics table, leaving unrelated modules free to finish.
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE source_discoveries IN ACCESS EXCLUSIVE MODE');
    const tabs = page.getByRole('navigation', { name: '看板周期' });
    await tabs.getByRole('link', { name: '近7天趋势' }).click();
    await expect(tabs.getByRole('link', { name: '近7天趋势' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('region', { name: '内容转化', exact: true })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(page.getByRole('img', { name: /^订阅趋势：/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: '栏目表现', exact: true })).toBeVisible();
    await expect(page.locator('.dashboard-section-table')).toBeVisible();

    await tabs.getByRole('link', { name: '近30天趋势' }).click();
    await expect(tabs.getByRole('link', { name: '近30天趋势' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('region', { name: '内容转化', exact: true })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(page.getByRole('img', { name: /^订阅趋势：/ })).toBeVisible();
    await blocker.query('ROLLBACK');
    await expect(page.getByRole('region', { name: '内容转化', exact: true })).not.toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(page.getByRole('img', { name: /^每日合格事件与日报采用：/ })).toBeVisible();
    await expect(page.locator('.dashboard-loading')).toHaveCount(0);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await db.end();
  }
});
