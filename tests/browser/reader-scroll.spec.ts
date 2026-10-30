import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
test('标题去前缀、目录跟随滚动、左右侧栏保持可见', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const row = (
    await db.query(
      "SELECT id,published FROM briefs WHERE kind='daily' AND published IS NOT NULL ORDER BY period_date DESC LIMIT 1",
    )
  ).rows[0];
  const original = row.published;
  try {
    const content = {
      ...original,
      title: '数智参阅｜滚动与标题检查',
      items: original.items.map((item: any) => ({ ...item, summary: item.summary.repeat(6) })),
    };
    await db.query('UPDATE briefs SET published=$2 WHERE id=$1', [row.id, JSON.stringify(content)]);
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.goto('/');
    await expect(page.locator('.report-heading h1')).toHaveText('滚动与标题检查');
    await expect(page.locator('.period-link.current .period-name')).toHaveText('滚动与标题检查');
    const nodes = page.locator('.daily-workspace .outline-list a');
    const target = nodes.nth(2);
    const hash = await target.getAttribute('href');
    await page.evaluate((value) => {
      const element = document.getElementById(value!.slice(1));
      window.scrollTo({
        top: element!.getBoundingClientRect().top + window.scrollY - 40,
        behavior: 'instant',
      });
    }, hash);
    await expect(target).toHaveAttribute('aria-current', 'location');
    expect((await page.locator('.sidebar').boundingBox())!.y).toBeGreaterThanOrEqual(0);
    expect((await page.locator('.context').boundingBox())!.y).toBeGreaterThanOrEqual(0);
    const leftHeading = await page.locator('.sidebar .issue-group > summary').first().boundingBox();
    const rightHeading = await page.locator('.context .context-head').first().boundingBox();
    expect(Math.abs(leftHeading!.y - rightHeading!.y)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: '.data/reader-scroll-sticky.png' });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect(nodes.first()).toHaveAttribute('aria-current', 'location');
  } finally {
    await db.query('UPDATE briefs SET published=$2 WHERE id=$1', [
      row.id,
      JSON.stringify(original),
    ]);
    await db.end();
  }
});

test('今日要览在栏目表格内编辑并保存', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const original = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
  try {
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/editorial/columns');
    await expect(page.getByLabel('字数超额容差（%）')).toBeVisible();
    await expect(page.getByLabel('标题写作要求')).toBeVisible();
    const row = page.locator('table tbody tr[data-column-kind="highlights"]');
    await expect(row.getByLabel('今日要览名称')).toHaveValue('今日要览');
    await row.getByLabel('今日要览名称').fill('今日重点');
    await row.getByLabel('今日要览下限').fill('2');
    await row.getByLabel('今日要览上限', { exact: true }).fill('4');
    await row.getByLabel('今日要览字数预算', { exact: true }).fill('180');
    await expect(row.getByLabel('今日要览单条字数上限', { exact: true })).toHaveCount(0);
    await page.getByLabel('字数超额容差（%）').fill('15');
    await row
      .getByLabel('今日要览栏目要求', { exact: true })
      .fill('优先突出金融机构需要关注的影响');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await page.reload();
    await expect(row.getByLabel('今日要览上限', { exact: true })).toHaveValue('4');
    const config = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
    expect([
      config.highlightsMaxItems,
      config.highlightsBudget,
      config.highlightsName,
      config.highlightsMinItems,
      config.budgetTolerancePercent,
      config.highlightsPrompt,
    ]).toEqual([4, 180, '今日重点', 2, 15, '优先突出金融机构需要关注的影响']);
    await page.screenshot({ path: '.data/highlights-inline-row.png', fullPage: true });
    await row.getByLabel('今日要览删除').click();
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await expect
      .poll(
        async () =>
          (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value.highlightsDeleted,
      )
      .toBe(true);
    await page.getByRole('button', { name: '恢复要览', exact: true }).click();
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await expect
      .poll(
        async () =>
          (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value.highlightsDeleted,
      )
      .toBe(false);
    await page.goto('/admin/editorial/ratings');
    await page.getByLabel('内容不足时放宽门槛').uncheck();
    await expect(page.getByLabel('最多下调分数')).toHaveCount(0);
    await page.getByLabel('内容不足时放宽门槛').check();
    await expect(page.getByLabel('最多下调分数')).toBeVisible();
    await page.screenshot({ path: '.data/rating-relaxation-desktop.png', fullPage: true });
    await page.getByLabel('最多下调分数').fill('0.4');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    const saved = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
    expect(saved.ratingRelaxationEnabled).toBe(true);
    expect(saved.ratingRelaxationMaxDrop).toBe(0.4);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: '.data/rating-relaxation-mobile.png', fullPage: true });
  } finally {
    await db.query('UPDATE settings SET value=$1 WHERE id=1', [original]);
    await db.end();
  }
});
