import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

test('补刊、手工导入和发送记录归位，旧入口保留查询参数', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const title = `手工材料-${randomUUID()}`;
  try {
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page
      .getByRole('navigation', { name: '管理导航' })
      .getByRole('link', { name: '出刊管理', exact: true })
      .click();
    await page.getByRole('link', { name: '手动补刊', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/backfill$/);
    await expect(page.getByRole('button', { name: '预览补刊期数', exact: true })).toBeVisible();
    await page.goto('/admin/settings?notice=入口已迁移&event=legacy');
    await expect(page).toHaveURL(/\/admin\/settings\?/);
    await expect(page.getByRole('status')).toHaveText('入口已迁移');
    await expect(page.getByLabel('资讯处理并发数')).toHaveCount(0);
    await expect(page.getByLabel('简报主标题字数上限')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '预览补刊期数', exact: true })).toHaveCount(0);
    await page.goto('/admin/settings/runtime');
    await expect(page.getByLabel('资讯处理并发数')).toBeVisible();
    await expect(page.getByLabel('生成成功后直接发布')).toHaveCount(0);
    await expect(page.getByLabel('启用疑难归组与事实复核')).toHaveCount(0);
    await page.screenshot({ path: '.data/admin-runtime-desktop.png', fullPage: true });
    await page.goto('/admin/articles');
    await page.getByRole('link', { name: '手工录入资讯', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '手工录入资讯', exact: true })).toBeVisible();
    await page.screenshot({ path: '.data/manual-import-dialog.png' });
    await page.getByLabel('标题', { exact: true }).fill(title);
    await page
      .getByLabel('原文链接', { exact: true })
      .fill(`https://example.invalid/${randomUUID()}`);
    await page.getByLabel('来源名称', { exact: true }).fill('手工来源');
    await page.getByLabel('发布时间（北京时间）').fill('2026-10-22T07:00');
    await page.getByLabel('摘要', { exact: true }).fill('一条有依据的AI工具更新材料。');
    await page.getByRole('button', { name: '录入资讯', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/articles\?/);
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await expect(page.getByRole('row').filter({ hasText: title })).toBeVisible();
    await page.goto('/admin/subscriptions');
    await expect(page.getByRole('button', { name: '手动推送', exact: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '订阅时间', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '手动推送', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '手动推送' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('link', { name: '推送记录', exact: true }).click();
    await expect(page.getByRole('columnheader', { name: '推送时间', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '手动推送', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.goto('/admin/settings/runtime');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: '.data/admin-runtime-mobile.png', fullPage: true });
  } finally {
    await db.query('DELETE FROM articles WHERE title=$1', [title]);
    await db.end();
  }
});
