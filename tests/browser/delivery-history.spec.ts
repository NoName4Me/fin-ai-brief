import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { fixtureContent } from '../fixtures.ts';

test('推送记录可翻页，单条失败重推保留页码且仅重排目标，关闭推送或退订时禁用', async ({ page }) => {
  if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
    throw new Error('必须使用独立_test数据库');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const original = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
  const briefId = randomUUID();
  const ids: string[] = [];
  const sends: string[] = [];
  try {
    await db.query(
      "INSERT INTO briefs(id,kind,period_date,published,issue_number) VALUES($1,'daily','2026-11-14',$2,20)",
      [briefId, JSON.stringify(fixtureContent())],
    );
    for (let i = 0; i < 55; i++) {
      const id = randomUUID();
      const send = randomUUID();
      ids.push(id);
      sends.push(send);
      await db.query(
        'INSERT INTO subscriptions(id,email,kinds,token_hash) VALUES($1,$2,\'["daily"]\'::jsonb,$3)',
        [id, `history-${String(i).padStart(2, '0')}@example.invalid`, randomUUID()],
      );
      const state = i === 0 || i === 52 ? 'failed' : i === 50 ? 'uncertain' : 'sent';
      await db.query(
        'INSERT INTO deliveries(id,brief_id,subscription_id,state,error,created_at) VALUES($1,$2,$3,$4,$5,$6)',
        [
          send,
          briefId,
          id,
          state,
          state === 'failed'
            ? '发送失败：EAUTH · AUTH PLAIN · Invalid login: 535 Login fail'
            : null,
          new Date(Date.UTC(2026, 10, 14, 0, 0, i)),
        ],
      );
    }
    const configured = {
      ...original,
      deliveryEnabled: true,
      mailConnection: {
        host: 'smtp.example.invalid',
        port: 465,
        security: 'tls',
        user: 'sender@example.invalid',
        password: 'test-only-password',
        from: 'sender@example.invalid',
      },
    };
    await db.query('UPDATE settings SET value=$1 WHERE id=1', [JSON.stringify(configured)]);
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/subscriptions/history');
    await expect(page.getByRole('columnheader', { name: '操作', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '推送记录分页' })).toContainText(
      '共55条 · 第1/2页',
    );
    await expect(page.locator('tbody tr')).toHaveCount(50);
    const failed = page.getByRole('row').filter({ hasText: 'history-52@example.invalid' });
    await expect(failed.getByRole('button', { name: '重新推送', exact: true })).toBeEnabled();
    const uncertain = page.getByRole('row').filter({ hasText: 'history-50@example.invalid' });
    await expect(uncertain.getByRole('button')).toHaveCount(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      await failed.getByRole('button', { name: '重新推送', exact: true }).scrollIntoViewIfNeeded();
      await expect(failed.getByRole('button', { name: '重新推送', exact: true })).toBeInViewport();
      expect(
        await failed
          .locator('td')
          .nth(3)
          .evaluate((el) => el.getBoundingClientRect().width),
      ).toBeGreaterThan(250);
      await page.screenshot({ path: `.data/delivery-history-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('link', { name: '下一页', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(5);
    const target = page.getByRole('row').filter({ hasText: 'history-00@example.invalid' });
    await db.query('UPDATE settings SET value=$1 WHERE id=1', [
      JSON.stringify({ ...configured, deliveryEnabled: false }),
    ]);
    await page.reload();
    await expect(target.getByRole('button', { name: '重新推送', exact: true })).toBeDisabled();
    await expect(target).toContainText('请先开启推送');
    await db.query('UPDATE settings SET value=$1 WHERE id=1', [JSON.stringify(configured)]);
    await db.query('UPDATE subscriptions SET active=false WHERE id=$1', [ids[0]]);
    await page.reload();
    await expect(target.getByRole('button', { name: '重新推送', exact: true })).toBeDisabled();
    await expect(target).toContainText('该邮箱已退订');
    await db.query('UPDATE subscriptions SET active=true WHERE id=$1', [ids[0]]);
    await page.reload();
    await target.getByRole('button', { name: '重新推送', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已重新加入发送队列');
    await expect(page).toHaveURL(/history\?page=2&notice=/);
    expect(
      (await db.query('SELECT state,error FROM deliveries WHERE id=$1', [sends[0]])).rows[0],
    ).toEqual({ state: 'pending', error: null });
    expect(
      (await db.query('SELECT state FROM deliveries WHERE id=$1', [sends[52]])).rows[0].state,
    ).toBe('failed');
    await page.getByRole('link', { name: '上一页', exact: true }).click();
    const retried = page.getByRole('row').filter({ hasText: 'history-00@example.invalid' });
    await expect(retried).toContainText('待发送');
    await expect(retried.getByRole('button')).toHaveCount(0);
  } finally {
    await db.query('DELETE FROM deliveries WHERE brief_id=$1', [briefId]);
    await db.query('DELETE FROM subscriptions WHERE id=ANY($1::uuid[])', [ids]);
    await db.query('DELETE FROM briefs WHERE id=$1', [briefId]);
    await db.query('UPDATE settings SET value=$1 WHERE id=1', [JSON.stringify(original)]);
    await db.end();
  }
});
