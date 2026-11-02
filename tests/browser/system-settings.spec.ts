import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { createServer } from 'node:http';

test('七天和三十天趋势中日报采用柱与绿色图例一致', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  for (const days of [7, 30]) {
    await page.goto(`/admin?view=${days}`);
    const legend = page.locator('.chart-legend i.selected');
    const color = await legend.evaluate((el) => getComputedStyle(el).backgroundColor);
    await expect(page.locator('.chart-bar-selected').first()).toHaveCSS('fill', color);
  }
});

test('系统设置统一保存，模型可临时测试，桌面和手机布局完整', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const original = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
  let received: unknown;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '模型已收到 test' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务未启动');
  try {
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/settings');
    await expect(page.getByText('连接状态', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(1);
    await expect(page.getByRole('switch', { name: '开启自动清理' })).toBeVisible();
    await expect(
      page.getByRole('group', { name: '数据保留' }).getByRole('button', { name: '立即清理' }),
    ).toBeVisible();
    await page.getByLabel('API 地址', { exact: true }).fill(`http://127.0.0.1:${address.port}/v1`);
    await page.getByLabel('API Key', { exact: true }).fill('temporary-test-key');
    await page.getByLabel('模型名称').fill('configured-model');
    await page.getByLabel('每日调用次数上限').fill('102');
    await page.getByLabel('原始资讯保留天数').fill('120');
    await page.getByRole('button', { name: '测试连通', exact: true }).click();
    await expect(page.locator('.model-test-success')).toHaveText('成功');
    await expect(page.getByText('模型已收到 test', { exact: true })).toBeVisible();
    expect(received).toMatchObject({
      model: 'configured-model',
      messages: [{ role: 'user', content: 'test' }],
    });
    expect(
      (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value.modelDailyLimit,
    ).toBe(original.modelDailyLimit);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    const saved = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
    expect(saved.modelConnection.model).toBe('configured-model');
    expect(saved.modelDailyLimit).toBe(102);
    expect(saved.newsRetentionDays).toBe(120);
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    expect(
      (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value.modelConnection
        .apiKey,
    ).toBe('temporary-test-key');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      await page.screenshot({ path: `.data/system-settings-${width}.png`, fullPage: true });
    }
    await page.goto('/archive');
    await expect(page.getByRole('heading', { name: '全部日报', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('起始日期')).toBeVisible();
    await expect(page.getByLabel('结束日期')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: '.data/archive-filters-mobile.png', fullPage: true });
    for (const path of ['/admin/articles', '/admin/sources', '/admin/publications']) {
      await page.goto(path);
      const buttons = page.locator('.admin-page-actions a, .source-toolbar > a');
      for (const button of await buttons.all()) await expect(button.locator('svg')).toHaveCount(1);
    }
  } finally {
    await db.query('UPDATE settings SET value=$1 WHERE id=1', [original]);
    await db.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
