import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

test('管理页操作、每日采集明细与评价、任务分页在桌面和手机可用', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const marker = randomUUID();
  let sourceId = '';
  try {
    sourceId = (
      await db.query(
        "INSERT INTO sources(name,url,format,industry_id,enabled) VALUES('核查信源',$1,'rss','ai',true) RETURNING id",
        [`https://example.invalid/${marker}`],
      )
    ).rows[0].id;
    const url = `https://example.invalid/observation/${marker}`;
    await db.query(
      "INSERT INTO articles(source_id,source_name,title,url,excerpt,published_at,industry_id,state,review_note) VALUES($1,'核查信源','核查标题',$2,'一项AI工具发布计划',now(),'ai','ignored','材料缺少实质新增事实')",
      [sourceId, url],
    );
    await db.query(
      "INSERT INTO source_discoveries(source_id,url,title,published_at,inserted) VALUES($1,$2,'核查标题',now(),true)",
      [sourceId, url],
    );
    await db.query(
      "INSERT INTO articles(title,url,excerpt,published_at,source_name,industry_id) SELECT $1||n,$2||n,'摘要',now(),'核查','ai' FROM generate_series(1,105) n",
      [marker, `https://example.invalid/tasks/${marker}/`],
    );
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/publications');
    await expect(page.getByRole('button', { name: '生成前检查' })).toHaveCount(0);
    await page.getByRole('link', { name: '手动补刊', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '手动补刊' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('起始日期')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '补刊', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.goto('/admin/sources');
    const add = page.getByRole('link', { name: '添加信源', exact: true });
    const automatic = page.getByRole('switch', { name: '自动采集' });
    expect((await add.boundingBox())!.x).toBeLessThan((await automatic.boundingBox())!.x);
    await page.screenshot({ path: '.data/refined-sources-desktop.png', fullPage: true });
    await page.goto('/admin/sources/monitor');
    await expect(page.getByRole('heading', { name: '运行状态' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '采集与内容贡献' })).toHaveCount(0);
    await expect(page.getByLabel('启用状态')).toHaveValue('enabled');
    await expect(page.getByRole('columnheader', { name: '重复率', exact: true })).toBeVisible();
    await page.getByLabel('搜索信源').fill('核查信源');
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await expect(page.locator('.source-monitor-table tbody tr')).toHaveCount(1);
    await page.getByRole('link', { name: '核查信源', exact: true }).click();
    await expect(
      page.getByRole('table', { name: '每日采集明细' }).getByText('核查标题', { exact: true }),
    ).toBeVisible();
    await page.getByText('核查标题', { exact: true }).click();
    await expect(page.getByText('材料缺少实质新增事实', { exact: true })).toBeVisible();
    await page.getByText('人工评价', { exact: true }).click();
    await page.getByLabel('评价', { exact: true }).selectOption('scope');
    await page.getByLabel('来源性质').selectOption('original');
    await page.getByLabel('评价依据').fill('抽查该条资讯，建议缩小采集范围。');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await page.getByText('人工评价', { exact: true }).click();
    await expect(page.getByText('抽查该条资讯，建议缩小采集范围。', { exact: true })).toBeVisible();
    await page.screenshot({ path: '.data/refined-source-detail-desktop.png', fullPage: true });
    await page.goto('/admin/editorial/ratings');
    await expect(page.getByRole('heading', { name: '评分指标' })).toHaveCount(0);
    const toggle = page.getByRole('switch', { name: '相关性启用', exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    const ratingsTop = (await page
      .getByRole('button', { name: '新增指标', exact: true })
      .boundingBox())!.y;
    await page.screenshot({ path: '.data/refined-ratings-desktop.png', fullPage: true });
    await page.goto('/admin/editorial/columns');
    expect(
      (await page.getByRole('button', { name: '新增栏目', exact: true }).boundingBox())!.y,
    ).toBe(ratingsTop);
    await page.goto(`/admin/articles?q=${marker}`);
    await expect(page.locator('table[aria-label="任务列表"] tbody > tr')).toHaveCount(50);
    await expect(page.getByRole('navigation', { name: '任务分页' })).toContainText('共105条');
    await page.getByRole('link', { name: '下一页', exact: true }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.locator('table[aria-label="任务列表"] tbody > tr')).toHaveCount(50);
    await page.getByRole('link', { name: '下一页', exact: true }).click();
    await expect(page.locator('table[aria-label="任务列表"] tbody > tr')).toHaveCount(5);
    await page.screenshot({ path: '.data/refined-tasks-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of [
      '/admin/sources',
      '/admin/editorial/ratings',
      '/admin/editorial/columns',
      '/admin/articles',
      `/admin/sources/monitor?source=${sourceId}`,
      '/admin/publications?configure=backfill',
    ]) {
      await page.goto(route);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        route,
      ).toBe(false);
      await page.screenshot({
        path: `.data/refined-${route.split('?')[0].split('/').at(-1)}-mobile.png`,
        fullPage: true,
      });
    }
  } finally {
    await db.query('DELETE FROM articles WHERE url LIKE $1 OR title LIKE $2', [
      `%${marker}%`,
      `${marker}%`,
    ]);
    if (sourceId) await db.query('DELETE FROM sources WHERE id=$1', [sourceId]);
    await db.end();
  }
});
