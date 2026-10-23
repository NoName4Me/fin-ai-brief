import { test, expect } from '@playwright/test';
const email = `browser-${Date.now()}@example.invalid`;
test('匿名访问管理页被拦截，管理员直接进入工作台', async ({ page }) => {
  await page.goto('/admin/subscriptions');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(
    page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '简报工作台' }),
  ).toHaveAttribute('aria-current', 'page');
  await page.getByRole('link', { name: '行业与栏目', exact: true }).click();
  await expect(
    page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '行业与栏目' }),
  ).toHaveAttribute('aria-current', 'page');
  await page.getByRole('link', { name: '出刊设置', exact: true }).click();
  const auto = page.getByLabel('生成成功后直接发布');
  const previous = await auto.isChecked();
  const quota = page.getByLabel('每日调用次数上限');
  const previousLimit = await quota.inputValue();
  const titleLimit = page.getByLabel('简报主标题字数上限');
  const weeklyDay = page.getByRole('combobox', { name: '周报出刊日', exact: true });
  const monthlyDay = page.getByRole('combobox', { name: '月报出刊日', exact: true });
  const previousTitle = await titleLimit.inputValue(),
    previousWeek = await weeklyDay.inputValue(),
    previousMonth = await monthlyDay.inputValue();
  try {
    await titleLimit.fill('48');
    await weeklyDay.selectOption('0');
    await monthlyDay.selectOption('31');
    const reducedLimit = String(Math.max(1, Number(previousLimit) - 1));
    await quota.fill(reducedLimit);
    await expect(page.getByText('今日已用', { exact: false })).toBeVisible();
    await auto.setChecked(!previous);
    await Promise.all([
      page.waitForResponse((response) => response.request().method() === 'POST'),
      page.getByRole('button', { name: '保存设置' }).click(),
    ]);
    await expect(page).toHaveURL(/\/admin\/settings\?notice=/);
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await expect(auto).toBeChecked({ checked: !previous });
    await expect(quota).toHaveValue(reducedLimit);
    await expect(titleLimit).toHaveValue('48');
    await expect(weeklyDay).toHaveValue('0');
    await expect(monthlyDay).toHaveValue('31');
    await titleLimit.fill(previousTitle);
    await weeklyDay.selectOption(previousWeek);
    await monthlyDay.selectOption(previousMonth);
    await quota.fill(previousLimit);
    await auto.setChecked(previous);
    await Promise.all([
      page.waitForResponse((response) => response.request().method() === 'POST'),
      page.getByRole('button', { name: '保存设置' }).click(),
    ]);
    await expect(page).toHaveURL(/\/admin\/settings\?notice=/);
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
  } finally {
    const { Pool } = await import('pg');
    const cleanup = new Pool({ connectionString: process.env.DATABASE_URL });
    await cleanup.query('UPDATE settings SET value=value||$1::jsonb WHERE id=1', [
      JSON.stringify({
        autoPublish: previous,
        modelDailyLimit: Number(previousLimit),
        briefTitleMaxLength: Number(previousTitle),
        weeklyDay: Number(previousWeek),
        monthlyDay: Number(previousMonth),
      }),
    ]);
    await cleanup.end();
  }
  await page.getByRole('button', { name: '退出管理台' }).click();
  await expect(page).toHaveURL(/\/login$/);
});
test('订阅登记、退订确认和管理员删除登记可完成', async ({ page }) => {
  await page.goto('/subscribe');
  await page.getByLabel('邮箱地址').fill(email);
  await page.getByRole('button', { name: '登记订阅' }).click();
  await expect(page.getByText('邮箱已登记。', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: '保存这个退订链接' }).click();
  await page.getByRole('button', { name: '确认退订' }).click();
  await expect(page.getByRole('status')).toHaveText('操作已完成');
  await page.goto('/login');
  await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto('/admin/subscriptions');
  const row = page.getByRole('row').filter({ hasText: email });
  await expect(row).toContainText('已退订');
  await row.getByRole('button', { name: '删除登记' }).click();
  await expect(page.getByText(email, { exact: true })).toHaveCount(0);
});
test('手机可切换简报类型并打开订阅入口', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('link', { name: '周报', exact: true }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/kind=weekly/);
  await expect(page.getByRole('heading', { name: '周报' })).toBeVisible();
  await page.getByRole('link', { name: '邮箱订阅', exact: true }).click();
  await expect(page.getByLabel('邮箱地址')).toBeVisible();
});

test('来源入口打开对应资料弹窗，关闭后可查看其他资讯来源', async ({ page }) => {
  const { Pool } = await import('pg');
  const readPool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await readPool.query(
    "SELECT published FROM briefs WHERE kind='daily' AND published IS NOT NULL ORDER BY period_date DESC LIMIT 1",
  );
  await readPool.end();
  const content = rows[0].published as import('../../src/server/types.ts').BriefContent;
  const items = content.items.filter((item) => item.sources.length).slice(0, 2);
  expect(items).toHaveLength(2);
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: '来源与依据', exact: true });
  for (const item of items) {
    const card = page.locator('article').filter({
      has: page.getByRole('heading', { name: item.title, exact: true }),
    });
    await card.getByRole('button', { name: '来源与依据', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(item.title);
    for (const source of item.sources) {
      await expect(dialog.getByRole('link', { name: source.title, exact: true })).toHaveAttribute(
        'href',
        source.url,
      );
    }
    await dialog.getByRole('button', { name: '关闭来源弹窗' }).click();
    await expect(dialog).toBeHidden();
  }
});

test('信源按行业分组，可独立折叠，JSON不再细分品牌格式', async ({ page }) => {
  const { pool } = await import('../../src/server/db.ts');
  const tag = `browser-source-${Date.now()}`;
  const added = await pool.query(
    `INSERT INTO sources(name,url,format,industry_id,enabled) VALUES
      ($1,$2,'rss','finance',false),($3,$4,'json','ai',false) RETURNING id`,
    [
      `${tag}-金融`,
      `https://example.invalid/${tag}/finance`,
      `${tag}-AI`,
      `https://example.invalid/${tag}/ai`,
    ],
  );
  try {
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/sources');
    const finance = page
      .locator('details')
      .filter({ has: page.getByRole('heading', { name: '金融', exact: true }) });
    const ai = page
      .locator('details')
      .filter({ has: page.getByRole('heading', { name: 'AI', exact: true }) });
    await expect(finance.getByText(`${tag}-金融`, { exact: false })).toBeVisible();
    await expect(ai.getByText(`${tag}-AI`, { exact: false })).toBeVisible();
    await finance.getByRole('heading', { name: '金融', exact: true }).click();
    await expect(finance.getByText(`${tag}-金融`, { exact: false })).toBeHidden();
    await expect(ai.getByText(`${tag}-AI`, { exact: false })).toBeVisible();
    await ai.getByText(`${tag}-AI`, { exact: false }).click();
    const format = ai.getByLabel('格式').last();
    await expect(format).toHaveValue('json');
    await expect(format.locator('option')).toHaveText(['RSS / Atom', 'JSON', '网页 / HTML']);
    await page.screenshot({ path: '.data/sources-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(ai.getByRole('heading', { name: 'AI', exact: true })).toBeVisible();
    await page.screenshot({ path: '.data/sources-mobile.png', fullPage: true });
  } finally {
    await pool.query('DELETE FROM sources WHERE id=ANY($1::uuid[])', [
      added.rows.map((row) => row.id),
    ]);
    await pool.end();
  }
});

test('本期侧栏与正文共用标题，7×24独立阅读并可切换实时更新', async ({ page }) => {
  await page.goto('/');
  const title = await page.locator('.report-heading h1').textContent();
  await expect(
    page.getByRole('complementary', { name: '简报归档' }).getByText(title!, { exact: true }),
  ).toBeVisible();
  await page.goto('/news?industry=ai&q=AI');
  await expect(page.getByRole('complementary', { name: '简报归档' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '简报类型' })).toHaveCount(0);
  const live = page.getByRole('switch', { name: '实时更新' });
  await expect(live).toBeChecked();
  await live.uncheck();
  await expect(page.getByText('自动更新已暂停')).toBeVisible();
  await page.getByRole('button', { name: '刷新资讯', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新资讯', exact: true })).toBeEnabled();
  await expect(page).toHaveURL(/industry=ai&q=AI/);
  await expect(live).not.toBeChecked();
  await live.check();
  await expect(page.getByText('实时已连接')).toBeVisible();
  await expect(page.getByText('经由', { exact: false })).toHaveCount(0);
});

test('SSE新消息先提示，点击后才加入列表并保留筛选条件', async ({ page }) => {
  const initial = await (await page.request.get('/api/news?industry=ai')).json();
  expect(initial.items.length).toBeGreaterThan(0);
  const item = {
    ...initial.items[0],
    id: '99999999-9999-4999-8999-999999999991',
    title: '【测试】SSE新增资讯',
    summary: '仅浏览器拦截响应，不写生产库。',
    occurredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await page.route('**/api/news/stream?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `id: 999\nevent: update\ndata: ${JSON.stringify({ cursor: '999', items: [item], changed: [item.id] })}\n\n`,
    });
  });
  await page.goto('/news?industry=ai');
  const heading = page.getByRole('heading', { name: item.title, exact: true });
  await expect(page.getByRole('button', { name: '↑ 1条新资讯，点击查看' })).toBeVisible();
  await expect(heading).toHaveCount(0);
  await page.getByRole('button', { name: '↑ 1条新资讯，点击查看' }).click();
  await expect(heading).toBeVisible();
  await expect(heading).toHaveCount(1);
  await expect(page).toHaveURL(/industry=ai/);
});

test('管理台模型、任务、采集调频与出刊配置入口可用且手机不溢出', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page
      .getByRole('navigation', { name: '管理导航' })
      .getByRole('link', { name: '出刊设置', exact: true })
      .click();
    await expect(page.getByLabel('开启自动采集')).toBeVisible();
    await expect(page.getByLabel('起刊日期', { exact: true })).toBeVisible();
    await expect(page.getByLabel('周报出刊时间（北京时间）')).toBeVisible();
    await page.screenshot({ path: `.data/schedule-${width}.png`, fullPage: true });
    await expect(page.getByRole('link', { name: '模型与额度', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('每日调用次数上限')).toBeVisible();
    await page
      .getByRole('navigation', { name: '管理导航' })
      .getByRole('link', { name: '任务管理', exact: true })
      .click();
    await expect(
      page
        .getByRole('navigation', { name: '管理导航' })
        .getByRole('link', { name: '任务管理', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    const row = page.getByRole('row').nth(1);
    await row.getByRole('button', { name: '详情', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '任务详情' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('任务ID：', { exact: false }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: `.data/tasks-dialog-${width}.png`, fullPage: false });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(row.getByRole('button', { name: '详情', exact: true })).toBeFocused();
    await page.screenshot({ path: `.data/tasks-${width}.png`, fullPage: false });
  }
});

test('旧任务入口进入统一列表，点击资讯行查看原始材料和实际阶段结果', async ({ page }) => {
  const { Pool } = await import('pg');
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const title = `弹窗阶段验证-${Date.now()}`;
  const { rows } = await p.query(
    "INSERT INTO articles(title,url,excerpt,published_at,source_name,industry_id) VALUES($1,$2,'这是一段本地测试摘要',now(),'本地验证','ai') RETURNING id",
    [title, `https://example.invalid/modal-${Date.now()}`],
  );
  const id = rows[0].id;
  try {
    await p.query(
      "INSERT INTO processing_steps(subject,run_key,stage,state,finished_at,result) VALUES($1,'local-ui','validate','succeeded',now(),$2)",
      [`article:${id}`, JSON.stringify({ checked: '本地阶段结果' })],
    );
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/jobs');
    await expect(page).toHaveURL(/\/admin\/articles$/);
    const row = page.getByRole('row').filter({ hasText: title });
    await row.getByRole('button', { name: '详情', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '任务详情' });
    await dialog.getByText('原始摘要', { exact: true }).click();
    await expect(dialog.getByText('这是一段本地测试摘要', { exact: true })).toBeVisible();
    await expect(dialog).toContainText('材料校验与URL去重');
    await expect(dialog).toContainText('成功');
    await expect(dialog).toContainText('开始：');
    await dialog.getByText('查看结果', { exact: true }).click();
    await expect(dialog).toContainText('本地阶段结果');
    await dialog.getByRole('button', { name: '关闭任务详情' }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await p.query('DELETE FROM processing_steps WHERE subject=$1', [`article:${id}`]);
    await p.query('DELETE FROM articles WHERE id=$1', [id]);
    await p.end();
  }
});
