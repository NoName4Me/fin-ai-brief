import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
const testDatabase =
  process.env.DATABASE_URL && /_test$/.test(new URL(process.env.DATABASE_URL).pathname);
test.skip(!testDatabase, '界面写入验证仅在独立测试库运行');
test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
});

test('重试与并发通过弹窗保存，操作通知固定右上角并可关闭', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const old = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
  try {
    await page.goto('/admin/articles?configure=tasks');
    await page.getByLabel('失败后自动重试次数').fill('2');
    await page.getByLabel('资讯处理并发数').fill('4');
    await page.getByRole('button', { name: '保存任务配置' }).click();
    const notice = page.getByRole('status');
    await expect(notice).toHaveText('操作已完成');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(notice).toBeInViewport();
    const box = await page.locator('.notification').boundingBox();
    expect(box!.y).toBeLessThan(50);
    expect(box!.x).toBeGreaterThan(900);
    await page.screenshot({ path: '.data/notification-desktop.png' });
    await page.getByRole('button', { name: '关闭通知' }).click();
    await expect(notice).toHaveCount(0);
    await page.goto('/admin/articles?configure=tasks');
    await expect(page.getByLabel('失败后自动重试次数')).toHaveValue('2');
    await expect(page.getByLabel('资讯处理并发数')).toHaveValue('4');
    await page.getByRole('button', { name: '保存任务配置' }).click();
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(notice).toBeInViewport();
    await page.getByRole('button', { name: '关闭通知' }).click();
  } finally {
    await db.query('UPDATE settings SET value=$1 WHERE id=1', [old]);
    await db.end();
  }
});
test('资讯详情最新阶段在前，生成前展示强制处理的二次确认', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const id = randomUUID();
  const title = `倒序时间线-${id}`;
  try {
    await db.query(
      "INSERT INTO articles(id,title,url,excerpt,published_at,source_name,industry_id) VALUES($1,$2,$3,'待处理测试材料','2026-10-21T12:00:00Z','本地界面测试','ai')",
      [id, title, `https://example.invalid/${id}`],
    );
    await db.query("UPDATE articles SET state='failed' WHERE id=$1", [id]);
    await db.query(
      `INSERT INTO processing_steps(subject,run_key,stage,state,started_at,finished_at,error) VALUES
      ($1,'ui-order','validate','succeeded',now()-interval '2 minutes',now()-interval '1 minute',NULL),
      ($1,'ui-order','analyze','failed',now()-interval '1 minute',now(),'模型分析失败：The operation was aborted due to timeout')`,
      [`article:${id}`],
    );
    await page.goto('/admin/articles?q=' + encodeURIComponent(title));
    await page.getByRole('button', { name: '详情', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '任务详情' });
    await expect(dialog.locator('.task-timeline h3')).toHaveCount(2);
    const headings = await dialog.locator('.task-timeline h3').allTextContents();
    expect(headings[0]).toContain('模型分析');
    expect(headings[1]).toContain('材料校验');
    await expect(dialog.getByText('失败阶段：模型分析', { exact: false })).toBeVisible();
    await expect(dialog.getByText('模型请求等待 180 秒后仍未返回，被系统中止')).toBeVisible();
    await expect(
      dialog
        .locator('.task-timeline')
        .getByText('模型分析失败：The operation was aborted due to timeout'),
    ).toBeVisible();
    await expect(dialog.locator('.task-stage.stage-failed')).toHaveCount(1);
    await page.screenshot({ path: '.data/task-timeline-desc.png' });
    await db.query("UPDATE articles SET state='pending' WHERE id=$1", [id]);
    await page.goto('/admin?preview=1&kind=daily&date=2026-10-22');
    await expect(page.getByRole('heading', { name: '确认强制生成日报' })).toBeVisible();
    const confirmation = page.getByRole('checkbox', {
      name: '确认优先处理本期未完成资讯后强制生成',
    });
    await expect(confirmation).not.toBeChecked();
    await expect(confirmation).toHaveAttribute('required', '');
    await page.getByRole('button', { name: '确认强制生成' }).click();
    await expect(page).toHaveURL(/preview=1/);
    expect((await db.query('SELECT count(*)::int n FROM brief_requests')).rows[0].n).toBe(0);
    await page.screenshot({ path: '.data/force-generation-confirm.png' });
  } finally {
    await db.query('DELETE FROM processing_steps WHERE subject=$1', [`article:${id}`]);
    await db.query('DELETE FROM articles WHERE id=$1', [id]);
    await db.end();
  }
});

test('7×24入口暂时隐藏，旧地址返回日报', async ({ page }) => {
  await page.goto('/news');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', { name: '7×24资讯' })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: '实时更新' })).toHaveCount(0);
});
