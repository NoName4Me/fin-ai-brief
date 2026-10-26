import { test, expect } from '@playwright/test';
import { networkInterfaces } from 'node:os';

test('局域网IP访问可建立开发连接并打开来源与依据', async ({ page, baseURL }) => {
  const address = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
  test.skip(!address, '没有可用的局域网地址');
  const url = new URL(baseURL!);
  url.hostname = address!;
  let frames = 0;
  const errors: string[] = [];
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/_next/hmr')) return;
    socket.on('framereceived', () => frames++);
    socket.on('socketerror', (error) => errors.push(String(error)));
  });
  await page.goto(url.href);
  const source = page.getByRole('button', { name: '来源与依据', exact: true }).first();
  test.skip(!(await source.count()), '需要已有正式简报');
  await expect.poll(() => frames, { timeout: 10000 }).toBeGreaterThan(0);
  await source.click();
  await expect(page.locator('dialog.source-dialog[open]')).toBeVisible();
  await page.getByRole('button', { name: '关闭来源弹窗' }).click();
  await expect(page.locator('dialog.source-dialog[open]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('分类内全宽短讯不继承双栏右栏的边框与缩进', async ({ page }) => {
  await page.goto('/');
  const stories = page.locator('.section-stories > .chapter-brief');
  test.skip(!(await stories.count()), '需要含全宽短讯的简报');
  for (const width of [1440, 800, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const story of await stories.all()) {
      await expect(story).toHaveCSS('border-left-width', '0px');
      await expect(story).toHaveCSS('padding-left', '0px');
    }
  }
});

test('刊型切换只读取正式数据，月报往返周报不携带示例状态', async ({ page }) => {
  await page.goto('/?kind=weekly');
  const title = await page.locator('.paper h1').first().textContent();
  const weeklyLinks = await page
    .locator('.sidebar .period-link')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  test.skip(!weeklyLinks.length, '需要已发布周报');
  await page.locator('.sidebar').getByRole('link', { name: '月报', exact: true }).click();
  await expect(page.locator('.sample-sidebar')).toHaveCount(0);
  await page.locator('.sidebar').getByRole('link', { name: '周报', exact: true }).click();
  await expect(page).toHaveURL(/\?kind=weekly$/);
  await expect(page.locator('.paper h1').first()).toHaveText(title!);
  expect(
    await page
      .locator('.sidebar .period-link')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
  ).toEqual(weeklyLinks);
  await page.goto('/?kind=weekly&sample=1');
  await expect(page.locator('.paper h1').first()).toHaveText(title!);
});

test('周报侧栏展示周次与日期角标，视觉样式与日报一致', async ({ page }) => {
  await page.goto('/?kind=weekly');
  test.skip(!(await page.locator('.period-paper').count()), '需要正式周报');
  const calendar = page.locator('.sidebar .period-calendar-weekly').first();
  await expect(calendar.locator('.period-day')).toHaveText(
    (await page.locator('.period-date-mark > strong').textContent())!,
  );
  const detail = (await page.locator('.period-date-range').textContent())!.split('-');
  await expect(calendar.locator('.period-range-start')).toHaveText(detail[0]);
  await expect(calendar.locator('.period-range-end')).toHaveText(detail[1]);
  await expect(calendar.locator('.period-day')).toHaveCSS('font-size', '25px');
  await expect(calendar.locator('.period-day')).toHaveCSS('font-weight', '900');
  await expect(page.locator('.period-meta-line')).toHaveCount(0);
  await expect(page.locator('.period-opening')).toHaveCSS('background-color', 'rgb(238, 236, 229)');
  await expect(
    page.locator('.period-paper').getByRole('heading', { name: '本周要情', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.period-domain .chapter-heading h2')).toHaveText([
    '金融要情',
    'AI要情',
  ]);
  await expect(page.locator('.period-story h4').first()).toHaveCSS('margin-top', '0px');
  expect(
    await page
      .locator('.period-story')
      .first()
      .evaluate(
        (el) =>
          el.querySelector('h4')!.getBoundingClientRect().top -
          el.querySelector('.period-story-meta')!.getBoundingClientRect().bottom,
      ),
  ).toBeLessThanOrEqual(6);
});

test('历史简报页无左栏，日报周报月报共用右栏宽度', async ({ page }) => {
  await page.goto('/archive');
  await expect(page.getByRole('heading', { name: '历史简报', exact: true })).toBeVisible();
  await expect(page.locator('aside.sidebar')).toHaveCount(0);
  await expect(page.locator('.archive-tools')).toBeVisible();
  await page.goto('/');
  const daily = await page
    .locator('.workspace > .context')
    .evaluate((element) => element.getBoundingClientRect().width);
  await page.goto('/?kind=weekly');
  test.skip(!(await page.locator('.period-paper').count()), '需要正式周报');
  const context = page.locator('.workspace > .context');
  expect(await context.evaluate((element) => element.getBoundingClientRect().width)).toBe(daily);
  await page
    .locator('.period-workspace')
    .evaluate((element) => element.classList.replace('period-weekly', 'period-monthly'));
  expect(await context.evaluate((element) => element.getBoundingClientRect().width)).toBe(daily);
});

test('正文来源精简为一项，来源弹窗仍包含全部记录并将X排在最后', async ({ page }) => {
  await page.goto('/?kind=weekly');
  test.skip(!(await page.locator('.period-paper').count()), '需要正式周报');
  const rows = page.locator('.period-paper .source-row');
  for (const row of await rows.all()) {
    const records = row.locator('.source-detail-content > p');
    const count = await records.count();
    const summary = await row.locator(':scope > span').first().textContent();
    expect(summary).not.toMatch(/[（(](?:网页|RSS)/i);
    if (count > 1) expect(summary).toMatch(/ 等$/);
    else expect(summary).not.toMatch(/ 等$/);
    const hrefs = await records.evaluateAll((items) =>
      items.map((item) => item.querySelector('a')!.href),
    );
    let reachedX = false;
    for (const href of hrefs) {
      const host = new URL(href).hostname;
      const isX = /(^|\.)(x|twitter)\.com$/.test(host);
      if (isX) reachedX = true;
      else expect(reachedX).toBe(false);
    }
  }
  const row = rows.first();
  const count = await row.locator('.source-detail-content > p').count();
  await row.getByRole('button', { name: '来源与依据' }).click();
  await expect(page.locator('dialog[open] .source-detail-content > p')).toHaveCount(count);
});
