import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

test('批次汇入紧凑列表，详情显示逐条结果，仅重试失败项', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const batchId = randomUUID();
  const ids = [randomUUID(), randomUUID()];
  try {
    await db.query(
      `INSERT INTO reprocessing_batches(id,range_start,range_end,scope,state,total,finished_at) VALUES($1,'2026-10-21','2026-10-22','all','completed_with_errors',2,now())`,
      [batchId],
    );
    for (const [index, id] of ids.entries()) {
      await db.query(
        "INSERT INTO articles(id,title,url,excerpt,published_at,source_name,industry_id,state) VALUES($1,$2,$3,'AI材料','2026-10-21T12:00:00Z','来源','ai',$4)",
        [id, `批内资讯-${index}`, `https://example.invalid/${id}`, index ? 'failed' : 'processed'],
      );
      await db.query(
        'INSERT INTO reprocessing_items(batch_id,article_id,article_snapshot,state,error) SELECT $1,id,to_jsonb(a),$3,$4 FROM articles a WHERE id=$2',
        [batchId, id, index ? 'failed' : 'processed', index ? '模型请求超时' : null],
      );
    }
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/articles');
    await expect(page.getByRole('heading', { name: '重新处理批次' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '批量重新处理', exact: true })).toBeVisible();
    const row = page.locator(`tr[data-task-id="batch:${batchId}"]`);
    await expect(row).toContainText('批量重处理');
    await expect(row).toContainText('完成，有失败项');
    await expect(row).toContainText('2/2');
    expect((await row.boundingBox())!.height).toBeLessThan(55);
    await expect(page.getByRole('row').filter({ hasText: '批内资讯-1' })).toHaveCount(0);
    await page.screenshot({ path: '.data/batch-list-compact-desktop.png', fullPage: true });
    await row.getByRole('button', { name: '详情', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '批量重处理详情' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('table', { name: '批次逐条结果' }).locator('tbody tr'),
    ).toHaveCount(2);
    await expect(dialog.getByText('模型请求超时', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: '.data/batch-detail-mobile.png', fullPage: true });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await row.getByRole('button', { name: '重试失败项', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    const items = (
      await db.query('SELECT state FROM reprocessing_items WHERE batch_id=$1 ORDER BY state', [
        batchId,
      ])
    ).rows;
    expect(items.map((item) => item.state)).toEqual(['processed', 'waiting']);
    await page.getByRole('link', { name: '批量重新处理', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '批量重新处理', exact: true })).toBeVisible();
    await expect(page.getByLabel('处理范围', { exact: true })).toBeVisible();
  } finally {
    await db.query('DELETE FROM reprocessing_batches WHERE id=$1', [batchId]);
    await db.query('DELETE FROM articles WHERE id=ANY($1::uuid[])', [ids]);
    await db.end();
  }
});
