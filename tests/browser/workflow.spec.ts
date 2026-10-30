import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { randomUUID, randomBytes, createHash, createHmac } from 'node:crypto';
async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}
test('匿名管理访问被拦截，审核开关与额度可以保存', async ({ page }) => {
  await page.goto('/admin/editorial');
  await expect(page).toHaveURL(/\/login/);
  await login(page);
  await page.getByText('编辑规则', { exact: true }).click();
  await page.getByRole('link', { name: '整刊配置', exact: true }).click();
  await expect(page.getByLabel('政策与监管字数预算')).toHaveValue('250');
  await expect(page.locator('textarea[name="keywords"]')).toHaveCount(0);
  await expect(page.getByLabel('行业', { exact: true })).toHaveCount(0);
  await page.goto('/admin/publications?configure=publication');
  const auto = page.getByLabel('生成成功后直接发布');
  const prior = await auto.isChecked();
  await expect(page.getByLabel('每日调用次数上限')).toHaveCount(0);
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const old = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
  try {
    await auto.setChecked(!prior);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await page.reload();
    await page.goto('/admin/publications?configure=publication');
    await expect(auto).toBeChecked({ checked: !prior });

    await expect(page.getByLabel('截稿时间（北京时间）')).toHaveValue('08:00');
    await expect(page.getByLabel('周报出刊日', { exact: true })).toHaveCount(0);
    await page.goto('/admin/settings');
    const limit = page.getByLabel('每日调用次数上限');
    await limit.fill('99');
    await page.getByRole('button', { name: '保存模型额度', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await page.reload();
    await expect(limit).toHaveValue('99');
    expect(
      (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value.autoPublish,
    ).toBe(!prior);
  } finally {
    await db.query('UPDATE settings SET value=$1 WHERE id=1', [old]);
    await db.end();
  }
});
test('用户端需确认邮箱，确认后可退订与删除', async ({ page }) => {
  const email = `browser-${Date.now()}@example.invalid`;
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await page.goto('/subscribe');
    await expect(page.getByText('提交后需通过邮件确认', { exact: false })).toBeVisible();
    await page.goto('/subscribe?registered=1');
    await expect(page.getByRole('status')).toContainText('链接24小时内有效');
    await page.screenshot({ path: '.data/subscription-check-email.png' });
    const token = randomBytes(32).toString('base64url');
    await db.query(
      "INSERT INTO subscription_confirmations(email,token_hash,kinds,expires_at) VALUES($1,$2,'[\"daily\"]',now()+interval '24 hours')",
      [email, createHash('sha256').update(token).digest('hex')],
    );
    await page.goto(`/subscribe/confirm?token=${token}`);
    await expect(page.getByRole('heading', { name: '订阅已确认' })).toBeVisible();
    await page.screenshot({ path: '.data/subscription-confirmed-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.data/subscription-confirmed-mobile.png' });
    const row = (await db.query('SELECT id,active FROM subscriptions WHERE email=$1', [email]))
      .rows[0];
    expect(row.active).toBe(true);
    const cancel = `${row.id}.${createHmac('sha256', process.env.APP_SECRET!).update(row.id).digest('base64url')}`;
    await page.goto(`/unsubscribe?token=${encodeURIComponent(cancel)}`);
    await page.getByRole('button', { name: '确认退订' }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await page.goto('/subscribe/confirmed?status=expired');
    await expect(page.getByRole('heading', { name: '确认链接已过期' })).toBeVisible();
    await page.screenshot({ path: '.data/subscription-expired-mobile.png' });
    await login(page);
    await page.goto('/admin/subscriptions');
    const listed = page.getByRole('row').filter({ hasText: email });
    await expect(listed).toContainText('已退订');
    await listed.getByRole('button', { name: '删除登记' }).click();
    await expect(page.getByText(email, { exact: true })).toHaveCount(0);
  } finally {
    await db.query('DELETE FROM subscription_confirmations WHERE email=$1', [email]);
    await db.end();
  }
});
test('来源弹窗可逐条打开，半星与今日要览显示', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日要览', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: '4.5分，满分5分' }).first()).toBeVisible();
  const first = page.locator('article[id^="event-"]').first();
  await first.getByRole('button', { name: '来源与依据', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '来源与依据', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('link').first()).toHaveAttribute('href', /https:/);
  await dialog.getByRole('button', { name: '关闭来源弹窗' }).click();
  await expect(dialog).toBeHidden();
});
test('栏目预算保存，轮动排期与记录可查', async ({ page }) => {
  await login(page);
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const old = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
  try {
    await page.goto('/admin/editorial');
    await page.getByLabel('工具与开源字数预算').fill('220');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await page.reload();
    await expect(page.getByLabel('工具与开源字数预算')).toHaveValue('220');
    await expect(
      page
        .getByRole('navigation', { name: '管理导航' })
        .getByRole('link', { name: '出刊记录', exact: true }),
    ).toHaveCount(0);
    await page.goto('/admin/editions');
    await expect(page).toHaveURL(/admin\/articles\?type=generate/);
  } finally {
    await db.query('UPDATE settings SET value=$1 WHERE id=1', [old]);
    await db.end();
  }
});
test('重新生成默认不重处理，勾选后只创建持久批次交给Worker', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const {
    rows: [article],
  } = await db.query(
    "INSERT INTO articles(title,url,excerpt,published_at,source_name,industry_id,state,processing_version) VALUES('界面重处理材料',$1,'AI工具更新','2026-10-21T12:00:00Z','本地界面测试','ai','processed','facts-v1') RETURNING id",
    [`https://example.invalid/${randomUUID()}`],
  );
  try {
    await login(page);
    await page.goto('/admin/publications');
    const row = page.getByRole('row').filter({ hasText: 'AI治理与工具进展' });
    const checkbox = row.getByRole('checkbox', { name: '先重新处理资讯' });
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await row.getByRole('button', { name: '重新生成', exact: true }).click();
    await expect(page.getByRole('heading', { name: '重新处理后生成', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '确认重新处理并生成', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    const result = (
      await db.query(
        'SELECT b.state,b.total FROM reprocessing_batches b JOIN reprocessing_items i ON i.batch_id=b.id WHERE i.article_id=$1',
        [article.id],
      )
    ).rows[0];
    expect(result.state).toBe('waiting');
    expect(result.total).toBe(1);
    expect(
      (await db.query('SELECT state FROM articles WHERE id=$1', [article.id])).rows[0].state,
    ).toBe('processed');
    await page.getByRole('link', { name: '任务管理', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: '批量重处理' })).toBeVisible();
  } finally {
    await db.query(
      'DELETE FROM reprocessing_batches WHERE id IN (SELECT batch_id FROM reprocessing_items WHERE article_id=$1)',
      [article.id],
    );
    await db.query('DELETE FROM articles WHERE id=$1', [article.id]);
    await db.end();
  }
});
test('候选与五维评分放在对应出刊任务详情中', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
  await boss.start();
  await boss.createQueue('generate', { policy: 'exclusive' });
  const id = await boss.send('generate', { kind: 'daily', date: '2025-01-02', trigger: 'manual' });
  const assessment = Object.fromEntries(
    ['relevance', 'impact', 'timeliness', 'actionability', 'novelty'].map((k) => [
      k,
      { score: 4, reason: '栏目候选评分依据' },
    ]),
  );
  try {
    await db.query(
      "UPDATE pgboss.job SET state='completed',started_on=now(),completed_on=now() WHERE id=$1",
      [id],
    );
    await db.query(
      "INSERT INTO processing_steps(subject,run_key,stage,state,finished_at,result) VALUES('brief:daily:2025-01-02',$1,'edition','succeeded',now(),$2)",
      [
        'job:' + id,
        JSON.stringify([
          {
            section: '政策与监管',
            status: 'published',
            candidate_count: 1,
            selected_count: 1,
            reason: '按评分采用',
            details: [
              {
                id: randomUUID(),
                title: '候选AI治理要求',
                rating: 4,
                assessment,
                selected: true,
                reason: '本期采用',
              },
            ],
          },
        ]),
      ],
    );
    await login(page);
    await page.goto('/admin/articles?type=generate&q=2025-01-02');
    await page
      .getByRole('row')
      .filter({ hasText: '2025-01-02' })
      .getByRole('button', { name: '详情', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: '任务详情' });
    await expect(dialog.getByRole('heading', { name: '栏目选题与出刊结果' })).toBeVisible();
    await dialog.getByText('政策与监管　候选1条／采用1条　已刊登', { exact: true }).click();
    await dialog.getByText('候选AI治理要求　4分　已采用', { exact: true }).click();
    await expect(dialog.getByText('相关性：4分', { exact: true })).toBeVisible();
    await expect(dialog.getByText('栏目候选评分依据').first()).toBeVisible();
  } finally {
    await db.query('DELETE FROM processing_steps WHERE run_key=$1', ['job:' + id]);
    await db.query('DELETE FROM pgboss.job WHERE id=$1', [id]);
    await boss.stop();
    await db.end();
  }
});
