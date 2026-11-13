import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { createServer } from 'node:http';

test('七天和三十天趋势中日报采用柱与绿色图例一致', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  for (const days of [7, 30]) {
    await page.goto(`/admin?view=${days}`);
    const legend = page.locator('.chart-legend i.selected');
    const color = await legend.evaluate((el) => getComputedStyle(el).backgroundColor);
    await expect(page.locator('.chart-bar-selected').first()).toHaveCSS('fill', color);
  }
});

test('系统设置与模型管理拆分保存，模型可测试，桌面和手机布局完整', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true });
  });
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const original = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
  let received: unknown;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '模型已收到 test' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务未启动');
  try {
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    const proxyHeaders = {
      origin: 'http://203.0.113.10:8080',
      'x-forwarded-host': '203.0.113.10:8080',
      'x-forwarded-proto': 'http',
    };
    const proxied = await page.request.post('/api/admin/models/test', {
      headers: proxyHeaders,
      data: { id: '__missing__' },
    });
    expect(proxied.status()).toBe(400);
    expect((await proxied.json()).response).toBe('模型配置不存在');
    const foreign = await page.request.post('/api/admin/models/test', {
      headers: { ...proxyHeaders, origin: 'http://evil.invalid' },
      data: { id: '__missing__' },
    });
    expect(foreign.status()).toBe(403);
    await page.goto('/admin/settings');
    await expect(page.getByText('连接状态', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(1);
    await expect(page.getByRole('switch', { name: '开启自动清理' })).toBeVisible();
    await expect(
      page.getByRole('group', { name: '数据保留' }).getByRole('button', { name: '立即清理' }),
    ).toBeVisible();
    await expect(page.getByRole('group', { name: '模型调用' })).toHaveCount(0);
    await expect(page.getByLabel('API 地址', { exact: true })).toHaveCount(0);
    await page.getByLabel('原始资讯保留天数').fill('120');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    expect(
      (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value.newsRetentionDays,
    ).toBe(120);

    await page.goto('/admin/models?panel=edit');
    const dialog = page.getByRole('dialog', { name: '添加模型' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('启用模型')).toHaveCount(0);
    await page.getByLabel('显示名称').fill('测试主力');
    await page.getByLabel('API 地址', { exact: true }).fill(`http://127.0.0.1:${address.port}/v1`);
    await page.getByLabel('API Key', { exact: true }).fill('temporary-test-key');
    await page.getByLabel('模型名称').fill('configured-model');
    await page.screenshot({ path: '.data/model-edit-dialog-1440.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: '.data/model-edit-dialog-390.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    const saved = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
    expect(saved.modelConnections[0]).toMatchObject({
      name: '测试主力',
      model: 'configured-model',
      enabled: true,
    });
    expect(saved.newsRetentionDays).toBe(120);

    await page.getByLabel('每日调用上限').fill('102');
    const policyGroup = page.getByRole('group', { name: '模型调用', exact: true });
    await expect(policyGroup).toBeVisible();
    const schedulingSwitch = page.getByRole('switch', { name: '开启模型调用', exact: true });
    await expect(policyGroup.getByRole('switch', { name: '开启模型调用' })).toHaveCount(1);
    await expect(schedulingSwitch).not.toBeChecked();
    await schedulingSwitch.click();
    await expect(schedulingSwitch).toBeChecked();
    await expect(policyGroup).toHaveCSS('border-top-width', '1px');
    expect((await policyGroup.boundingBox())!.width).toBeLessThan(
      (await page.locator('.admin-model-page').boundingBox())!.width * 0.85,
    );
    const policySaveButton = policyGroup.getByRole('button', { name: '保存', exact: true });
    await expect(policySaveButton).toHaveCSS('background-color', 'rgb(35, 60, 83)');
    expect(
      Math.abs(
        (await policySaveButton.boundingBox())!.x - (await policyGroup.boundingBox())!.x - 20,
      ),
    ).toBeLessThan(2);
    await policyGroup.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await expect
      .poll(
        async () =>
          (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value
            .modelSchedulingEnabled,
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value.modelDailyLimit,
      )
      .toBe(102);

    await page.goto('/admin/models?panel=edit');
    await page.getByLabel('显示名称').fill('备用模型');
    await page.getByLabel('API 地址', { exact: true }).fill(`http://127.0.0.1:${address.port}/v2`);
    await page.getByLabel('API Key', { exact: true }).fill('temporary-backup-key');
    await page.getByLabel('模型名称').fill('backup-model');
    await page.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    const withBackup = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
    const primaryModel = withBackup.modelConnections[0];
    const backupModel = withBackup.modelConnections[1];
    expect(backupModel).toMatchObject({ name: '备用模型', enabled: true });

    await page.goto(`/admin/models?panel=edit&edit=${saved.modelConnections[0].id}`);
    await expect(page.getByRole('dialog', { name: '编辑模型' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    const primaryRow = page.locator('.model-table tr').filter({ hasText: '测试主力' });
    const backupRow = page.locator('.model-table tr').filter({ hasText: '备用模型' });
    await expect(page.getByRole('heading', { name: '模型与备用顺序', exact: true })).toHaveCount(0);
    const addModelLink = page.getByRole('link', { name: '添加模型', exact: true });
    const activityLink = page.getByRole('link', { name: '运行记录', exact: true });
    expect((await activityLink.boundingBox())!.x).toBeGreaterThan(
      (await addModelLink.boundingBox())!.x,
    );
    await expect(page.locator('.model-list-summary')).toHaveCount(0);
    await expect(primaryRow.locator('.model-role')).toHaveText('主力');
    await expect(primaryRow.locator('.model-role')).toHaveCSS(
      'background-color',
      'rgb(35, 60, 83)',
    );
    await expect(backupRow.locator('.model-role')).toHaveText('备用');
    await expect(backupRow.locator('.model-role')).toHaveCSS(
      'background-color',
      'rgb(220, 232, 239)',
    );
    await expect(primaryRow.locator('.model-drag-handle')).toBeDisabled();
    await expect(backupRow.locator('.model-drag-handle')).toBeEnabled();
    await expect(backupRow.locator('.model-drag-handle svg')).toHaveCount(1);
    await expect(
      primaryRow.getByRole('button', { name: '测试', exact: true }).locator('svg'),
    ).toHaveCount(0);
    await expect(
      primaryRow.getByRole('button', { name: '编辑', exact: true }).locator('svg'),
    ).toHaveCount(0);
    expect(
      (await backupRow.getByRole('button', { name: '设为主力', exact: true }).boundingBox())!.x,
    ).toBeGreaterThan(
      (await backupRow.getByRole('button', { name: '暂停', exact: true }).boundingBox())!.x,
    );
    await backupRow.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    const pausedRow = page.locator('.model-table tr').filter({ hasText: '备用模型' });
    await expect(pausedRow.locator('.model-role')).toHaveText('已停用');
    await expect(pausedRow.locator('.model-role')).toHaveCSS(
      'background-color',
      'rgb(233, 232, 228)',
    );
    await pausedRow.getByRole('button', { name: '启用', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await page.evaluate(async () => {
      await fetch('/api/admin/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: '__warmup__' }),
      });
    });
    await page.waitForTimeout(300);
    const primaryTestButton = primaryRow.getByRole('button', { name: '测试', exact: true });
    await expect(primaryTestButton).toBeEnabled();
    await primaryTestButton.click();
    const testResult = primaryRow.locator('.managed-model-test-result');
    await expect(testResult.locator('strong')).toHaveText('连通');
    await expect(page.getByText('模型已收到 test', { exact: true })).toBeVisible();
    expect((await testResult.boundingBox())!.y).toBeGreaterThan(
      (await primaryTestButton.boundingBox())!.y + (await primaryTestButton.boundingBox())!.height,
    );
    await page.screenshot({ path: '.data/model-test-result-row-1440.png', fullPage: true });
    expect(received).toMatchObject({
      model: 'configured-model',
      messages: [{ role: 'user', content: 'test' }],
    });
    expect(
      (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value.modelConnections[0]
        .apiKey,
    ).toBe('temporary-test-key');

    await page.goto('/admin/models?panel=edit');
    await page.getByLabel('显示名称').fill('第三模型');
    await page.getByLabel('API 地址', { exact: true }).fill(`http://127.0.0.1:${address.port}/v3`);
    await page.getByLabel('API Key', { exact: true }).fill('temporary-third-key');
    await page.getByLabel('模型名称').fill('third-model');
    await page.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    const secondRow = page.locator('.model-table tbody tr').nth(1);
    const thirdRow = page.locator('.model-table tbody tr').nth(2);
    await expect(thirdRow.locator('.model-drag-handle')).toHaveAttribute('data-ready', 'true');
    await thirdRow.locator('.model-drag-handle').dragTo(secondRow);
    await expect(page.locator('.model-table tbody tr').nth(1)).toContainText('第三模型');
    await expect
      .poll(async () =>
        (
          await db.query('SELECT value FROM settings WHERE id=1')
        ).rows[0].value.modelConnections.map((model: { name: string }) => model.name),
      )
      .toEqual(['测试主力', '第三模型', '备用模型']);

    await db.query(
      `INSERT INTO model_attempts(
        model_config_id,model_name,provider_model,state,error_category,error,started_at,finished_at
      ) VALUES($1,'测试主力','configured-model','failed','server-error','HTTP 503',now(),now())`,
      [saved.modelConnections[0].id],
    );
    await db.query(
      `INSERT INTO model_events(
        model_config_id,event_type,from_model_config_id,to_model_config_id,message
      ) VALUES($1,'fallback',$1,$2,'旧格式切换事件'),
      ($2,'recovered',$2,$1,'旧格式恢复事件')`,
      [primaryModel.id, backupModel.id],
    );
    await db.query(
      `INSERT INTO model_events(model_config_id,event_type,message)
       VALUES(NULL,'config-changed','移除「临时模型」')`,
    );
    await db.query(
      `UPDATE settings
       SET value=jsonb_set(value,'{dailyTime}','"23:59"')
       WHERE id=1`,
    );
    await page.goto('/admin/models?panel=logs&tab=activity');
    const activeActivityLink = page.getByRole('link', { name: '运行记录', exact: true });
    const listPanel = page.locator('.model-list-panel');
    const logPanel = page.locator('.model-log-panel');
    await expect(activeActivityLink).toHaveAttribute('aria-current', 'page');
    await expect(activeActivityLink).toHaveCSS('background-color', 'rgb(35, 60, 83)');
    expect((await activeActivityLink.boundingBox())!.x).toBeGreaterThan(
      (await page.getByRole('link', { name: '添加模型', exact: true }).boundingBox())!.x,
    );
    expect((await activeActivityLink.boundingBox())!.x).toBeLessThan(
      (await logPanel.boundingBox())!.x,
    );
    expect(
      Math.abs((await listPanel.boundingBox())!.y - (await logPanel.boundingBox())!.y),
    ).toBeLessThan(2);
    await expect(page.locator('.model-log-close')).toHaveCSS('border-top-width', '0px');
    await primaryRow.getByRole('button', { name: '编辑', exact: true }).click();
    const editModelDialog = page.getByRole('dialog', { name: '编辑模型' });
    await expect(editModelDialog).toBeVisible();
    await expect(page).toHaveURL(/panel=logs.*tab=activity.*edit=/);
    await editModelDialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page).toHaveURL(/panel=logs.*tab=activity/);
    await expect(page.locator('.model-log-panel')).toBeVisible();
    await primaryRow.getByRole('button', { name: '编辑', exact: true }).click();
    const reopenedEditDialog = page.getByRole('dialog', { name: '编辑模型' });
    await expect(page).toHaveURL(/edit=/);
    await expect(reopenedEditDialog).toBeVisible();
    await reopenedEditDialog.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await expect(page).toHaveURL(/panel=logs.*tab=activity/);
    await expect(page.locator('.model-log-panel')).toBeVisible();
    const pauseWhileLogsOpen = page
      .locator('.model-table tr')
      .filter({ hasText: '备用模型' })
      .getByRole('button', { name: '暂停', exact: true });
    await pauseWhileLogsOpen.click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await expect(page).toHaveURL(/panel=logs.*tab=activity/);
    await expect(page.locator('.model-log-panel')).toBeVisible();
    await page
      .locator('.model-table tr')
      .filter({ hasText: '备用模型' })
      .getByRole('button', { name: '启用', exact: true })
      .click();
    await expect(page.getByRole('status')).toHaveText('操作已完成');
    await expect(page).toHaveURL(/panel=logs.*tab=activity/);
    const hourLabels = await page.locator('.chart-hour-label').allTextContents();
    expect(hourLabels.length).toBeGreaterThan(0);
    expect(hourLabels.every((label) => /^\d{2}$/.test(label))).toBe(true);
    await expect(page.locator('.chart-now-label')).toHaveText('现在');
    await expect(page.locator('.chart-midnight-label')).toHaveText(['今', '昨']);
    await expect(page.locator('.chart-model-guide')).toHaveCount(3);
    await expect(page.locator('.chart-model-guide').first()).toHaveCSS('stroke-width', '0.5px');
    await expect(page.locator('.chart-time-axis')).toHaveCount(0);
    await expect(page.locator('.model-chart-legend')).toHaveCount(0);
    await expect(page.locator('.model-chart-scroll')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '运行记录' })).toHaveCount(0);
    await expect(page.locator('.model-chart-wrap')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)',
    );
    await page.locator('.model-bubble').click();
    await expect(page.getByRole('dialog')).toContainText('HTTP 503');
    expect(await page.getByRole('dialog').evaluate((element) => element.matches(':modal'))).toBe(
      true,
    );
    for (let index = 0; index < 4; index++) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(() =>
          Boolean(
            document.activeElement?.closest(
              '.model-list-panel, .model-policy-form, .model-log-toolbar',
            ),
          ),
        ),
      ).toBe(false);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.model-bubble')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '关闭异常详情' }).click();
    await page.getByRole('link', { name: '运行事件', exact: true }).click();
    const fallbackItem = page
      .locator('.model-timeline li')
      .filter({ hasText: '测试主力 调用异常，测试主力 → 备用模型' });
    const recoveryItem = page
      .locator('.model-timeline li')
      .filter({ hasText: '主模型 测试主力 恢复，备用模型 → 测试主力' });
    await expect(fallbackItem).toBeVisible();
    await expect(recoveryItem).toBeVisible();
    await expect(fallbackItem.locator('time')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
    await expect(recoveryItem.locator('time')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
    await expect(fallbackItem.locator('small')).toHaveText('自动');
    await expect(recoveryItem.locator('small')).toHaveText('自动');
    expect((await fallbackItem.locator('small').boundingBox())!.x).toBeGreaterThan(
      (await fallbackItem.locator('.model-timeline-message').boundingBox())!.x +
        (await fallbackItem.locator('.model-timeline-message').boundingBox())!.width,
    );
    await expect(fallbackItem.locator('.timeline-mark svg')).toHaveCount(1);
    await expect(recoveryItem.locator('.timeline-mark svg')).toHaveCount(1);
    const timelineMarks = page.locator('.model-timeline .timeline-mark');
    await expect(timelineMarks.first()).toHaveCSS('background-color', 'rgb(220, 232, 239)');
    await expect(timelineMarks.first()).toHaveCSS('width', '20px');
    await expect(timelineMarks.first()).toHaveCSS('border-top-width', '1px');
    await expect(timelineMarks.first()).toHaveCSS('color', 'rgb(35, 60, 83)');
    await expect(timelineMarks.first().locator('svg')).toHaveAttribute('stroke-width', '2.25');
    const fallbackMark = fallbackItem.locator('.timeline-mark');
    const fallbackCopy = fallbackItem.locator('.model-timeline-copy');
    expect(
      Math.abs(
        (await fallbackMark.boundingBox())!.y +
          (await fallbackMark.boundingBox())!.height / 2 -
          ((await fallbackCopy.boundingBox())!.y + (await fallbackCopy.boundingBox())!.height / 2),
      ),
    ).toBeLessThan(1.5);
    expect(
      await fallbackItem
        .locator('.model-timeline-message')
        .evaluate((element) => getComputedStyle(element).color),
    ).not.toBe('rgb(35, 60, 83)');
    await expect(fallbackItem.locator('.timeline-action')).toHaveText('调用异常');
    await expect(fallbackItem.locator('.timeline-action')).toHaveCSS('color', 'rgb(35, 60, 83)');
    await expect(page.locator('.model-timeline-now')).toHaveCSS('text-align', 'right');
    await expect(page.locator('.model-timeline time').first()).toHaveCSS('text-align', 'right');
    for (const text of [
      '添加「第三模型」',
      '启用「备用模型」',
      '暂停「备用模型」',
      '移除「临时模型」',
    ])
      await expect(
        page
          .locator('.model-timeline li')
          .filter({ hasText: text })
          .first()
          .locator('.timeline-mark svg'),
      ).toHaveCount(1);
    await page.screenshot({ path: '.data/model-timeline-1440.png', fullPage: true });
    await page.getByRole('link', { name: '运行记录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/models$/);
    const restoredActivityLink = page.getByRole('link', { name: '运行记录', exact: true });
    await expect(restoredActivityLink).not.toHaveAttribute('aria-current', 'page');
    await expect(restoredActivityLink).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    expect((await restoredActivityLink.boundingBox())!.x).toBeLessThan(
      page.viewportSize()!.width / 2,
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const tab of ['activity', 'events']) {
        await page.goto(`/admin/models?panel=logs&tab=${tab}`);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          `${width}px 页面在 ${tab} 视图出现横向溢出`,
        ).toBe(false);
        await page.screenshot({
          path: `.data/model-management-${tab}-${width}.png`,
          fullPage: true,
        });
      }
    }
    await page.goto('/archive');
    await expect(page.getByRole('heading', { name: '全部日报', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('起始日期')).toBeVisible();
    await expect(page.getByLabel('结束日期')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: '.data/archive-filters-mobile.png', fullPage: true });
    for (const path of ['/admin/articles', '/admin/sources', '/admin/publications']) {
      await page.goto(path);
      const buttons = page.locator('.admin-page-actions a, .source-toolbar > a');
      for (const button of await buttons.all()) await expect(button.locator('svg')).toHaveCount(1);
    }
  } finally {
    await db.query('UPDATE settings SET value=$1 WHERE id=1', [original]);
    await db.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
