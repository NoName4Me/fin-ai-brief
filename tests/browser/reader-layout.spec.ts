import { test, expect } from '@playwright/test';
test('日报保留刊物风格，桌面手机无横向溢出', async ({ page }) => {
  for (const width of [1440, 800, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await expect(
      page.getByRole('banner').getByRole('link', { name: 'AI日报', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.report-heading h1')).toHaveText('AI治理与工具进展');
    await expect(page.getByRole('heading', { name: '金融要情', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'AI要情', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await expect(page.locator('.story-copy > .rating')).toHaveCount(0);
    await expect(page.locator('.story-copy .source-row > .rating')).toHaveCount(0);
    await expect(page.locator('.daily-story-heading > .rating')).toHaveCount(6);
    if (width === 1440) {
      const sources = page.locator('.daily-source-list');
      await expect(sources).not.toHaveAttribute('open');
      await sources.locator('summary').click();
      await expect(sources.locator('.source-files')).toBeVisible();
      await sources.locator('summary').click();
    }
    await page.locator('.story-copy .source-dialog-trigger').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '关闭来源弹窗' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.screenshot({ path: `.data/ai-daily-${width}.png`, fullPage: true });
  }
});
test('周月报与实时入口隐藏，旧参数不改变当前日报', async ({ page }) => {
  await page.goto('/?kind=weekly');
  await expect(page.locator('.report-heading h1')).toHaveText('AI治理与工具进展');
  await expect(page.getByRole('link', { name: '周报', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '月报', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '7×24资讯', exact: true })).toHaveCount(0);
  await page.goto('/news');
  await expect(page).toHaveURL(/\/$/);
});
test('历史日报可按日期查阅，侧栏与正文标题相同', async ({ page }) => {
  await page.goto('/');
  await expect(
    page
      .getByRole('complementary', { name: '简报归档' })
      .getByText('AI治理与工具进展', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '历史日报' })
    .click();
  await expect(page.getByRole('heading', { name: '历史日报', exact: true })).toBeVisible();
  await expect(page.locator('aside.sidebar')).toHaveCount(0);
  await page.getByRole('link').filter({ hasText: 'AI治理与工具进展' }).click();
  await expect(page.locator('.report-heading h1')).toHaveText('AI治理与工具进展');
});
