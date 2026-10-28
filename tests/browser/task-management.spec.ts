import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { randomUUID } from 'node:crypto';
const isolated =
  !!process.env.DATABASE_URL && /_test$/.test(new URL(process.env.DATABASE_URL).pathname);
test.skip(!isolated, '任务写入验证仅在独立_test库运行');
test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
});

test('管理台品牌、右上退出、菜单高亮及所有业务页无大块标题区', async ({ page }) => {
  await expect(
    page.getByRole('banner').getByRole('link', { name: '数智参阅 管理台' }),
  ).toBeVisible();
  await expect(page.getByRole('banner').getByRole('button', { name: '退出管理台' })).toBeVisible();
  await expect(page.getByRole('link', { name: '邮箱订阅', exact: true })).toHaveCount(0);
  await expect(page.locator('.sidebar-label')).toHaveCount(0);
  for (const [path, label] of [
    ['/admin/articles', '任务管理'],
    ['/admin/sources', '信源管理'],
    ['/admin/editorial', '栏目与篇幅'],
    ['/admin/editorial/ratings', '评分规则'],
    ['/admin/editorial/content', '收录与写作'],
    ['/admin/sources/import', '任务管理'],
    ['/admin/sources/monitor', '信源监控'],
    ['/admin/settings/runtime', '任务管理'],
    ['/admin/retention', '系统设置'],
    ['/admin/subscriptions/history', '订阅与推送'],
    ['/admin/settings', '系统设置'],
    ['/admin', '数据总览'],
    ['/admin/publications', '出刊管理'],
  ]) {
    await page.goto(path);
    await expect(page.locator('.admin-main > .view-header')).toHaveCount(0);
    await expect(
      page
        .getByRole('navigation', { name: '管理导航' })
        .getByRole('link', { name: label, exact: true }),
    ).toHaveAttribute('aria-current', 'page');
  }
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(page.getByRole('banner').getByRole('button', { name: '退出管理台' })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole('banner').getByRole('button', { name: '退出管理台' })).toBeVisible();
  await page.getByRole('banner').getByRole('button', { name: '退出管理台' }).click();
  await expect(page).toHaveURL(/\/login$/);
  const response = await page.request.get('/api/admin/tasks/job:' + randomUUID());
  expect(response.status()).toBe(401);
  await page.goto('/news');
  await expect(
    page.getByRole('banner').getByRole('button', { name: '邮箱订阅', exact: true }),
  ).toBeVisible();
});

test('统一任务表支持筛选、详情和失败重试，刷新保留筛选，手机布局可用', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
  await boss.start();
  const tag = `界面任务-${randomUUID().slice(0, 8)}`;
  const sourceId = randomUUID(),
    articleId = randomUUID(),
    requestId = randomUUID();
  const jobs: string[] = [];
  try {
    for (const name of ['collect', 'process', 'generate'])
      await boss.createQueue(name, { policy: 'exclusive' });
    await db.query(
      "INSERT INTO sources(id,name,url,format,industry_id) VALUES($1,$2,'https://example.invalid/ui-task','rss','ai')",
      [sourceId, tag + '信源'],
    );
    await db.query(
      "INSERT INTO articles(id,title,url,excerpt,published_at,source_name,industry_id) VALUES($1,$2,$3,'界面原始材料','2026-10-21T12:00:00Z','本地验证','ai')",
      [articleId, tag + '资讯', `https://example.invalid/${articleId}`],
    );
    const collect = await boss.send(
      'collect',
      { id: sourceId, sourceName: tag + '信源' },
      { retryLimit: 0 },
    );
    jobs.push(collect!);
    const failedProcess = (await boss.send('process', {
      id: articleId,
      articleTitle: tag + '资讯',
    }))!;
    jobs.push(failedProcess);
    await db.query("UPDATE pgboss.job SET state='failed',output=$2 WHERE id=$1", [
      failedProcess,
      JSON.stringify({ message: 'The operation was aborted due to timeout' }),
    ]);
    await db.query(
      `INSERT INTO processing_steps(subject,run_key,stage,state,error) VALUES
      ($1,$2,'validate','succeeded',NULL),
      ($1,$2,'analyze','failed','模型分析失败：The operation was aborted due to timeout')`,
      [`article:${articleId}`, `job:${failedProcess}`],
    );
    await db.query("UPDATE articles SET state='failed' WHERE id=$1", [articleId]);
    jobs.push(
      (await boss.send('generate', { kind: 'daily', date: '2026-10-20', trigger: 'auto' }))!,
    );
    await db.query(
      "UPDATE pgboss.job SET state='failed',started_on='2026-10-23T15:33:17Z',completed_on='2026-10-23T15:33:20Z',output=$2 WHERE id=$1",
      [collect, JSON.stringify({ message: '本地失败记录' })],
    );
    await db.query(
      "INSERT INTO brief_requests(id,kind,period_date,range_start,range_end,force) VALUES($1,'daily','2026-10-21','2026-10-20T00:00:00Z','2026-10-21T00:00:00Z',true)",
      [requestId],
    );
    await page.goto('/admin/articles');
    const table = page.getByRole('table', { name: '任务列表' });
    await expect(page.getByRole('table')).toHaveCount(1);
    await expect(table.getByRole('columnheader')).toHaveText([
      '任务类型',
      '任务名',
      '开始时间',
      '状态',
      '操作',
    ]);
    await expect(page.getByText('采集与出刊任务', { exact: true })).toHaveCount(0);
    await expect(page.locator('.task-import form[action] input[name="title"]')).toHaveCount(0);
    await expect(
      table.getByRole('row').filter({ hasText: '日报 2026-10-21（手动）' }),
    ).toContainText('等待资讯处理');
    await expect(
      table.getByRole('row').filter({ hasText: '日报 2026-10-20（自动）' }),
    ).toBeVisible();
    await page.screenshot({ path: '.data/task-management-desktop.png', fullPage: true });
    await page.getByRole('combobox', { name: '任务类型', exact: true }).selectOption('collect');
    await page.getByLabel('任务名', { exact: true }).fill(tag);
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    const row = table.getByRole('row').filter({ hasText: tag + '信源' });
    await expect(row).toContainText('2026-10-23 23:33:17');
    await expect(row.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '刷新', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '任务类型', exact: true })).toHaveValue(
      'collect',
    );
    await expect(page.getByLabel('任务名', { exact: true })).toHaveValue(tag);
    await row.getByRole('button', { name: '详情', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '任务详情' });
    await expect(dialog.getByText('完成时间', { exact: true })).toBeVisible();
    await expect(dialog).toContainText('本地失败记录');
    await page.keyboard.press('Escape');
    await expect(row.getByRole('button', { name: '详情', exact: true })).toBeFocused();
    await row.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    const retried = await db.query(
      "SELECT id,data FROM pgboss.job WHERE name='collect' AND data->>'id'=$1 AND state='created'",
      [sourceId],
    );
    expect(retried.rowCount).toBe(1);
    expect(retried.rows[0].data.manual).toBe(true);
    jobs.push(retried.rows[0].id);
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await expect(
      page.getByRole('banner').getByRole('button', { name: '退出管理台' }),
    ).toBeVisible();
    await page.screenshot({ path: '.data/task-management-mobile.png', fullPage: true });
    await page
      .getByRole('row')
      .filter({ hasText: tag + '资讯' })
      .getByRole('button', { name: '详情', exact: true })
      .click();
    await expect(dialog.getByText('原始摘要', { exact: true })).toBeVisible();
    await expect(dialog.getByText('失败阶段：模型分析', { exact: false })).toBeVisible();
    await expect(dialog.getByText('第 1 轮', { exact: false })).toBeVisible();
    await expect(
      dialog
        .locator('.task-timeline')
        .getByText('模型分析失败：The operation was aborted due to timeout'),
    ).toBeVisible();
    await dialog.getByText('原始摘要', { exact: true }).click();
    await expect(dialog.getByText('界面原始材料', { exact: true })).toBeVisible();
    await page.screenshot({ path: '.data/task-management-mobile-detail.png' });
  } finally {
    await db.query('DELETE FROM pgboss.job WHERE id=ANY($1::uuid[])', [jobs]);
    await db.query('DELETE FROM brief_requests WHERE id=$1', [requestId]);
    await db.query('DELETE FROM articles WHERE id=$1', [articleId]);
    await db.query('DELETE FROM sources WHERE id=$1', [sourceId]);
    await boss.stop();
    await db.end();
  }
});
