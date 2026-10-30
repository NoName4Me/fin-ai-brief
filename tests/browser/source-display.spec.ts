import { test, expect } from '@playwright/test';
import { Pool } from 'pg';

test('轮动来源复用依据弹窗、同媒体名称不重复，监控筛选桌面单行', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const row = (
    await db.query(
      "SELECT id,published FROM briefs WHERE kind='daily' AND published IS NOT NULL ORDER BY period_date DESC LIMIT 1",
    )
  ).rows[0];
  const source = {
    name: '虎嗅',
    title: '第一篇依据',
    url: 'https://example.invalid/one',
    publishedAt: '2026-10-21T01:00:00Z',
  };
  try {
    await db.query('UPDATE briefs SET published=$2 WHERE id=$1', [
      row.id,
      JSON.stringify({
        ...row.published,
        title: 'AI日报｜智能体复用、金融大模型标准与算力风险',
        rotations: [
          {
            name: '数据一图／观点摘编',
            text: '两篇材料分别提供事实依据。',
            sources: [
              source,
              {
                ...source,
                name: '虎嗅（网页）',
                title: '第二篇依据',
                url: 'https://example.invalid/two',
              },
              source,
            ],
          },
        ],
      }),
    ]);
    await page.goto(`/briefs/${row.id}`);
    await expect(page.locator('.report-heading h1')).toHaveText(
      '智能体复用、金融大模型标准与算力风险',
    );
    const rotation = page.locator('.daily-rotation');
    await expect(rotation.locator('.source-row > span').first()).toHaveText('虎嗅');
    await expect(rotation.locator('.source-row > a')).toHaveCount(0);
    await rotation.getByRole('button', { name: '来源与依据', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '来源与依据', exact: true });
    await expect(dialog.getByRole('link', { name: '第一篇依据', exact: true })).toHaveCount(1);
    await expect(dialog.getByRole('link', { name: '第二篇依据', exact: true })).toHaveCount(1);
    await dialog.getByRole('button', { name: '关闭来源弹窗' }).click();
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/publications');
    await expect(page.locator(`a[href="/briefs/${row.id}"]`)).toHaveText(
      '智能体复用、金融大模型标准与算力风险',
    );
    await page.goto('/admin/sources/monitor');
    const toolbar = page.locator('.monitor-toolbar');
    const centers = await toolbar.locator('.monitor-filters, :scope > a').evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return r.y + r.height / 2;
      }),
    );
    expect(centers.length).toBe(2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
    const tabs = await page.getByRole('navigation', { name: '统计周期' }).boundingBox();
    const filters = await toolbar.boundingBox();
    expect(tabs!.y + tabs!.height).toBeLessThanOrEqual(filters!.y);
    await expect(page.getByRole('columnheader', { name: '重复采集率', exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('columnheader', { name: '筛选通过率', exact: true }),
    ).toHaveAttribute('title', /不含待处理和失败/);
    await page.screenshot({ path: '.data/source-monitor-toolbar.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.data/source-monitor-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
  } finally {
    await db.query('UPDATE briefs SET published=$2 WHERE id=$1', [
      row.id,
      JSON.stringify(row.published),
    ]);
    await db.end();
  }
});
