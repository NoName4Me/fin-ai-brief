import { test, expect } from '@playwright/test';
import { Pool } from 'pg';

test('栏目、评分和收录分页面原地编辑，分别保存互不覆盖', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const previous = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
  try {
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/editorial');
    await expect(page).toHaveURL(/\/editorial\/columns$/);
    const columns = page.getByRole('region', { name: '栏目配置', exact: true });
    await expect(columns.locator('tbody tr')).toHaveCount(10);
    await expect(page.getByRole('region', { name: '评分指标配置', exact: true })).toHaveCount(0);
    await expect(page.locator('textarea[name="keywords"]')).toHaveCount(0);
    await expect(columns.locator('details')).toHaveCount(0);
    await page.getByLabel('技术与模型名称', { exact: true }).fill('技术前沿');
    await page.getByLabel('一周观察名称', { exact: true }).fill('周度观察');
    await page.getByLabel('周度观察出刊星期').fill('周二、周四');
    await page.getByLabel('周度观察间隔周数').fill('2');
    await page.getByLabel('技术前沿辅助关键词').fill('部署；智能体');
    await page.getByLabel('周度观察字数预算').fill('700');
    await page.getByLabel('每期最多事件数').fill('25');
    await page.getByLabel('简报主标题字数上限').fill('40');
    await page.getByRole('button', { name: '新增栏目', exact: true }).click();
    await page.getByLabel('新栏目名称', { exact: true }).fill('工程实践');
    await page.getByRole('button', { name: '保存栏目与篇幅', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await page.reload();
    await expect(page.getByLabel('周度观察出刊星期')).toHaveValue('周二、周四');
    await page.getByRole('button', { name: '关闭通知', exact: true }).click();
    await page.screenshot({ path: '.data/admin-columns-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: '.data/admin-columns-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('link', { name: '评分规则', exact: true }).click();
    await expect(page.getByRole('region', { name: '栏目配置', exact: true })).toHaveCount(0);
    const ratings = page.getByRole('region', { name: '评分指标配置', exact: true });
    await expect(ratings.locator('tbody tr')).toHaveCount(5);
    await page.getByLabel('可行动性启用', { exact: true }).uncheck();
    await expect(page.locator('[data-rating-id="relevance"] .editorial-share')).toHaveText('37.5%');
    await page.getByLabel('相关性权重').fill('40');
    await expect(page.locator('[data-rating-id="relevance"] .editorial-share')).toHaveText('44.4%');
    await page.getByLabel('影响面名称', { exact: true }).fill('覆盖程度');
    await page.getByLabel('覆盖程度描述').fill('评估对机构与使用者的影响范围');
    await page.getByLabel('日报候选门槛').fill('3.8');
    await page.getByLabel('要览候选门槛').fill('4.6');
    await page.getByRole('button', { name: '新增指标', exact: true }).click();
    await page.getByLabel('新指标名称', { exact: true }).fill('可复用性');
    await page.getByLabel('可复用性描述').fill('方法可复用程度');
    await page.getByLabel('可复用性启用', { exact: true }).uncheck();
    await page.getByRole('button', { name: '保存评分规则', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await page.reload();
    await expect(page.getByLabel('覆盖程度描述')).toHaveValue('评估对机构与使用者的影响范围');
    await page.getByRole('button', { name: '关闭通知', exact: true }).click();
    await page.screenshot({ path: '.data/admin-ratings-desktop.png', fullPage: true });
    await page.getByRole('link', { name: '收录与写作', exact: true }).click();
    await expect(page.getByRole('region', { name: '评分指标配置', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('标签（可选）', { exact: true })).toHaveCount(0);
    await page.getByLabel('启用疑难归组与事实复核').uncheck();
    await page.getByRole('button', { name: '保存收录与写作', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await page.reload();
    await page.getByRole('button', { name: '关闭通知', exact: true }).click();
    await page.screenshot({ path: '.data/admin-content-desktop.png', fullPage: true });
    const saved = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
    expect(saved.maxItems).toBe(25);
    expect(saved.briefTitleMaxLength).toBe(40);
    expect(saved.highlightRating).toBe(4.6);
    expect(saved.tags).toEqual(previous.tags);
    expect(saved.sections.find((s: { name: string }) => s.name === '技术前沿').keywords).toBe(
      '部署；智能体',
    );
    expect(saved.reviewEnabled).toBe(false);
    expect(saved.ratingRules.find((r: { id: string }) => r.id === 'impact').name).toBe('覆盖程度');
    expect(saved.sections.find((s: { id: string }) => s.id === '一周观察')).toMatchObject({
      name: '周度观察',
      weekdays: [2, 4],
      intervalWeeks: 2,
      lookbackDays: 14,
      budget: 700,
    });
    await page.goto('/admin/sources');
    await page.getByRole('link', { name: '添加信源', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '添加信源', exact: true });
    await expect(dialog.getByRole('checkbox', { name: '工程实践', exact: true })).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: '技术前沿', exact: true })).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: '技术与模型', exact: true })).toHaveCount(0);
    await page.goto('/admin/editorial/columns');
    await page.getByRole('button', { name: '工程实践删除', exact: true }).click();
    await page.getByRole('button', { name: '保存栏目与篇幅', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await page.goto('/admin/editorial/ratings');
    await page.getByRole('button', { name: '可复用性删除', exact: true }).click();
    await page.getByRole('button', { name: '保存评分规则', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await page.reload();
    await expect(page.getByLabel('可复用性名称')).toHaveCount(0);
    expect(
      (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value.sections.some(
        (s: { name: string }) => s.name === '工程实践',
      ),
    ).toBe(false);
  } finally {
    await db.query('UPDATE settings SET value=$1::jsonb WHERE id=1', [JSON.stringify(previous)]);
    await db.end();
  }
});
