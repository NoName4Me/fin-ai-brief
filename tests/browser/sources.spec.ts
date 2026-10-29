import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
});
test('候选无入口也可新增，多栏目可编辑为通用，新来源默认关闭', async ({ page }) => {
  const name = `候选来源-${randomUUID()}`;
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await page.goto('/admin/sources');
    await page.getByRole('link', { name: '添加信源', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '添加信源', exact: true });
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: '.data/source-add-dialog-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: '.data/source-add-dialog-mobile.png' });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page).not.toHaveURL(/add=1/);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('link', { name: '添加信源', exact: true }).click();
    await expect(dialog).toBeVisible();
    const form = dialog;
    await form.getByLabel('名称', { exact: true }).fill(name);
    await form.getByLabel('来源地址或账号').fill('公众号“候选来源”');
    await form.getByRole('checkbox', { name: '政策与监管', exact: true }).check();
    await form.getByRole('checkbox', { name: '风险与安全', exact: true }).check();
    await form.getByRole('button', { name: '添加信源', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toContainText('政策与监管、风险与安全');
    await expect(row.getByRole('switch')).not.toBeChecked();
    await expect(row.getByRole('switch')).toBeDisabled();
    await row.getByRole('link', { name: '详情' }).click();
    const editor = page.getByRole('dialog', { name: `${name}详情` });
    await expect(editor.getByLabel('验证状态').locator('option')).toHaveText([
      '待验证',
      '可用',
      '未通过',
    ]);
    await editor.getByRole('checkbox', { name: '政策与监管', exact: true }).uncheck();
    await editor.getByRole('checkbox', { name: '风险与安全', exact: true }).uncheck();
    await editor.getByRole('button', { name: '保存' }).click();
    await expect(row).toContainText('通用');
    await expect(page.getByLabel('行业', { exact: true })).toHaveCount(0);
    const saved = (await db.query('SELECT sections,url,enabled FROM sources WHERE name=$1', [name]))
      .rows[0];
    expect(saved).toEqual({ sections: [], url: null, enabled: false });
  } finally {
    await db.query('DELETE FROM sources WHERE name=$1', [name]);
    await db.end();
  }
});
test('信源平铺七列表头，开关可直接启停且不改栏目，手机列表局部滚动', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const id = randomUUID();
  const name = '已选用的范围信源';
  await db.query(
    `INSERT INTO sources(id,name,url,format,industry_id,sections,verification_status,verification_note)
    VALUES($1,$2,'https://example.invalid/feed','rss','ai','["技术与模型","风险与安全"]','approved','入口与抽样内容已核对')`,
    [id, name],
  );
  try {
    await page.goto('/admin/sources');
    await expect(page.getByRole('columnheader')).toHaveText([
      '信源名称',
      '归属栏目',
      '采集格式',
      '验证状态',
      '最近采集',
      /启用/,
      '操作',
    ]);
    const row = page.locator(`[data-source-id="${id}"]`);
    const toggle = row.getByRole('switch');
    await toggle.click();
    await expect(toggle).toBeChecked();
    const filter = page.getByRole('combobox', { name: '启用状态筛选' });
    await filter.selectOption('true');
    await expect(page).toHaveURL(/enabled=true/);
    const section = page.getByRole('combobox', { name: '栏目筛选', exact: true });
    const format = page.getByRole('combobox', { name: '采集格式筛选' });
    await expect(page.locator('thead select')).toHaveCount(0);
    await section.selectOption('政策与监管');
    await expect(row).toHaveCount(0);
    await section.selectOption('技术与模型');
    await expect(row).toBeVisible();
    await section.selectOption('风险与安全');
    await expect(row).toBeVisible();
    await format.selectOption('json');
    await expect(row).toHaveCount(0);
    await format.selectOption('rss');
    await expect(row).toBeVisible();
    await page.reload();
    await expect(filter).toHaveValue('true');
    await expect(section).toHaveValue('风险与安全');
    await expect(format).toHaveValue('rss');
    await expect(row).toBeVisible();
    await toggle.click();
    await expect(row).toHaveCount(0);
    await expect(page.getByText('没有符合筛选条件的信源')).toBeVisible();
    await filter.selectOption('false');
    await expect(page).toHaveURL(/enabled=false/);
    await expect(toggle).not.toBeChecked();
    await row.getByRole('link', { name: '详情' }).click();
    await expect(page).toHaveURL(/enabled=false.*format=rss&detail=/);
    const detail = page.getByRole('dialog', { name: `${name}详情` });
    await expect(detail).toBeVisible();
    await page.screenshot({ path: '.data/source-detail-dialog-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await detail.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: '.data/source-detail-dialog-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/sources\?enabled=false/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).not.toHaveURL(/detail=/);
    await expect(filter).toHaveValue('false');
    await filter.selectOption('');
    await expect(filter).toHaveValue('');
    await section.selectOption('general');
    await expect(row).toHaveCount(0);
    await section.selectOption('');
    await expect(row).toBeVisible();
    await format.selectOption('');
    await expect(page).toHaveURL(/\/admin\/sources$/);
    expect(
      (await db.query('SELECT enabled,sections FROM sources WHERE id=$1', [id])).rows[0],
    ).toEqual({ enabled: false, sections: ['技术与模型', '风险与安全'] });
    await page.screenshot({ path: '.data/source-list-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await expect(page.getByRole('region', { name: '信源列表' })).toBeVisible();
    await page.screenshot({ path: '.data/source-list-mobile.png' });
  } finally {
    await db.query('DELETE FROM sources WHERE id=$1', [id]);
    await db.end();
  }
});

test('详情读取开关及多入口配置可编辑保存', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const name = `多入口-${randomUUID()}`;
  const first = 'https://www.pbc.gov.cn/tiaofasi/144941/3581332/index.html';
  const second = 'https://www.pbc.gov.cn/tiaofasi/144941/144957/index.html';
  const {
    rows: [source],
  } = await db.query(
    "INSERT INTO sources(name,url,format,industry_id,additional_urls,read_details) VALUES($1,$2,'html','ai',$3::jsonb,true) RETURNING id",
    [name, first, JSON.stringify([second])],
  );
  try {
    await page.goto(`/admin/sources?source=${source.id}`);
    // Open through the row so URL parameter conventions remain covered by the normal UI.
    const row = page.locator(`[data-source-id="${source.id}"]`);
    if (!(await page.getByRole('dialog').count()))
      await row.getByRole('link', { name: '详情' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('采集入口', { exact: true })).toHaveValue(`${first}\n${second}`);
    const toggle = dialog.getByRole('switch', { name: '读取详情页' });
    await expect(toggle).toBeChecked();
    const size = await toggle.boundingBox();
    expect(size?.width).toBe(30);
    expect(size?.height).toBe(18);
    await toggle.uncheck();
    await dialog.getByLabel('采集入口', { exact: true }).fill(first);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    const {
      rows: [saved],
    } = await db.query('SELECT additional_urls,read_details FROM sources WHERE id=$1', [source.id]);
    expect(saved.additional_urls).toEqual([]);
    expect(saved.read_details).toBe(false);
  } finally {
    await db.query('DELETE FROM sources WHERE id=$1', [source.id]);
    await db.end();
  }
});
