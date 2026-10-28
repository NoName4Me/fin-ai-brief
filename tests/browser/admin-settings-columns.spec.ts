import { test, expect } from '@playwright/test';
import { Pool } from 'pg';

test('配置归位、栏目要求与关键词、拖拽保存及轮动自动规则', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const original = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
  try {
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: '待处理全部积压' })).toBeVisible();
    await expect(page.getByRole('link', { name: '采集失败信源' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: '管理导航' });
    await expect(nav.getByRole('link', { name: '系统设置', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: '出刊设置', exact: true })).toHaveCount(0);
    await page.goto('/admin/publications');
    await page.getByRole('link', { name: '出刊设置', exact: true }).click();
    const publication = page.getByRole('dialog', { name: '出刊设置' });
    await publication.getByLabel('起刊日期', { exact: true }).fill('2026-10-01');
    await publication.getByRole('button', { name: '保存出刊设置' }).click();
    await expect(publication).toHaveCount(0);
    await page.goto('/admin/articles');
    await page.getByRole('link', { name: '任务处理配置', exact: true }).click();
    const tasks = page.getByRole('dialog', { name: '任务处理配置' });
    await tasks.getByLabel('资讯处理并发数').fill('4');
    await tasks.getByRole('button', { name: '保存任务配置' }).click();
    await expect(tasks).toHaveCount(0);
    await page.goto('/admin/settings');
    await expect(page.getByLabel('资讯处理并发数')).toHaveCount(0);
    await expect(page.getByLabel('起刊日期')).toHaveCount(0);
    await expect(page.getByLabel('原始资讯保留天数')).toBeVisible();
    await page.getByLabel('每日调用次数上限').fill('101');
    await page.getByRole('button', { name: '保存模型额度' }).click();
    await page.goto('/admin/editorial/columns');
    await expect(page.getByLabel('政策与监管栏目要求')).not.toHaveValue('');
    await page.getByLabel('政策与监管辅助关键词').fill('生成式AI；备案');
    await expect(page.getByLabel('一周观察取材天数')).toHaveCount(0);
    await expect(page.getByLabel('一周观察排期基准日期')).toHaveCount(0);
    await page.getByLabel('一周观察间隔周数').fill('2');
    const rows = page
      .getByRole('region', { name: '栏目配置', exact: true })
      .locator('tbody tr[data-column-id]');
    const source = rows.last();
    const movedName = await source.locator('input[aria-label$="名称"]').inputValue();
    await source.getByRole('button', { name: /排序，使用上下方向键调整/ }).dragTo(rows.first());
    await expect(rows.first().locator('input[aria-label$="名称"]')).toHaveValue(movedName);
    await page.getByRole('button', { name: '保存栏目与篇幅' }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    const saved = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
    expect(saved.sections[0].name).toBe(movedName);
    expect(saved.sections.find((s: { name: string }) => s.name === '政策与监管').keywords).toBe(
      '生成式AI；备案',
    );
    const rotation = saved.sections.find((s: { name: string }) => s.name === '一周观察');
    expect(rotation.lookbackDays).toBe(14);
    expect(rotation.anchorDate).toBe('2026-10-01');
    expect(saved.processingConcurrency).toBe(4);
    expect(saved.modelDailyLimit).toBe(101);
    await page.getByRole('button', { name: '关闭通知', exact: true }).click();
    await page.screenshot({ path: '.data/columns-drag-keywords-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: '.data/columns-drag-keywords-mobile.png', fullPage: true });
    await page.goto('/admin/articles?configure=tasks');
    await expect(page.getByRole('dialog', { name: '任务处理配置' })).toBeVisible();
    await page.screenshot({ path: '.data/task-settings-modal-mobile.png', fullPage: true });
  } finally {
    await db.query('UPDATE settings SET value=$1 WHERE id=1', [original]);
    await db.end();
  }
});
