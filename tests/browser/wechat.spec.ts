import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
});

test('公众号管理支持扫码入口、账号列表和移除，移动端无横向溢出', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const sourceId = randomUUID();
  try {
    await page.goto('/admin/wechat');
    await expect(page.getByRole('heading', { name: '登录凭证' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '添加公众号' })).toBeVisible();
    await expect(page.getByText('尚未添加公众号')).toBeVisible();
    await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeDisabled();
    await page.route('**/api/admin/wechat/login', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId: '00000000-0000-4000-8000-000000000001',
          qrCode: 'data:image/png;base64,iVBORw0KGgo=',
        }),
      }),
    );
    await page.route('**/api/admin/wechat/login/00000000-0000-4000-8000-000000000001', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ state: 'waiting', message: '请使用微信扫描二维码' }),
      }),
    );
    await page.getByRole('button', { name: '扫码登录', exact: true }).click();
    await expect(page.getByRole('img', { name: '微信公众号登录二维码' })).toBeVisible();
    await expect(page.getByText('请使用微信扫描二维码')).toBeVisible();
    await page.screenshot({ path: '.data/wechat-desktop.png' });

    await db.query(
      `INSERT INTO sources(id,name,url,format,industry_id,enabled,verification_status,read_details)
       VALUES($1,'测试公众号','https://mp.weixin.qq.com/','wechat','ai',true,'approved',true)`,
      [sourceId],
    );
    await db.query(
      "INSERT INTO wechat_accounts(fakeid,nickname,alias,source_id) VALUES('test-fakeid','测试公众号','test-account',$1)",
      [sourceId],
    );
    await page.reload();
    const row = page.locator(`[data-source-id="${sourceId}"]`);
    await expect(row).toContainText('测试公众号');
    await expect(row).toContainText('已启用');
    await page.goto('/admin/sources');
    await expect(page.getByText('测试公众号', { exact: true })).toBeVisible();
    await page.goto('/admin/wechat');
    page.once('dialog', (dialog) => dialog.accept());
    await page
      .locator(`[data-source-id="${sourceId}"]`)
      .getByRole('button', { name: '移除' })
      .click();
    await expect(page.getByText('尚未添加公众号')).toBeVisible();
    expect((await db.query('SELECT 1 FROM sources WHERE id=$1', [sourceId])).rowCount).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: '.data/wechat-mobile.png' });
  } finally {
    await db.query('DELETE FROM sources WHERE id=$1', [sourceId]);
    await db.end();
  }
});

test('公众号可在统一信源表单中添加并编辑采集间隔', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const fakeid = `source-form-${randomUUID()}`;
  try {
    await db.query(
      `INSERT INTO wechat_credentials(id,secret,nickname,account_fakeid,expires_at)
       VALUES(1,'unused','自己的公众号','owner-id',now()+interval '1 day')`,
    );
    await page.route('**/api/admin/wechat/search', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          accounts: [
            {
              fakeid,
              nickname: '统一表单公众号',
              alias: 'unified-source',
              avatarUrl: '',
            },
          ],
        }),
      }),
    );
    await page.goto('/admin/sources?add=1');
    const dialog = page.getByRole('dialog', { name: '添加信源', exact: true });
    await dialog.getByRole('combobox', { name: '采集格式', exact: true }).selectOption('wechat');
    await expect(dialog.getByLabel('采集入口', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('公众号名称', { exact: true }).fill('统一表单');
    await dialog.getByRole('button', { name: '搜索', exact: true }).click();
    await dialog.getByRole('button', { name: '选择', exact: true }).click();
    await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue('统一表单公众号');
    await dialog.getByRole('button', { name: '添加信源', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');

    const {
      rows: [saved],
    } = await db.query(
      `SELECT s.id,s.url,s.read_details,s.interval_minutes,a.fakeid
       FROM sources s JOIN wechat_accounts a ON a.source_id=s.id WHERE a.fakeid=$1`,
      [fakeid],
    );
    expect(saved).toMatchObject({
      url: 'https://mp.weixin.qq.com/',
      read_details: true,
      interval_minutes: 60,
      fakeid,
    });
    const row = page.locator(`[data-source-id="${saved.id}"]`);
    await row.getByRole('link', { name: '详情' }).click();
    const editor = page.getByRole('dialog', { name: '统一表单公众号详情' });
    await expect(editor.getByRole('combobox', { name: '采集格式', exact: true })).toHaveValue(
      'wechat',
    );
    await expect(editor.getByText('已选择：统一表单公众号（unified-source）')).toBeVisible();
    await editor.getByLabel('采集间隔（分钟）', { exact: true }).fill('90');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    expect(
      (await db.query('SELECT interval_minutes FROM sources WHERE id=$1', [saved.id])).rows[0]
        .interval_minutes,
    ).toBe(90);
  } finally {
    await db.query(
      'DELETE FROM sources WHERE id IN (SELECT source_id FROM wechat_accounts WHERE fakeid=$1)',
      [fakeid],
    );
    await db.end();
  }
});
