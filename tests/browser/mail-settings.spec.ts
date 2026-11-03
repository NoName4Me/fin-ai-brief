import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { createServer, type Socket } from 'node:net';

test('推送配置在弹窗保存，连接测试不发信，密码不回显，页面只有一个推送开关', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const original = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  const smtp = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 localhost test SMTP\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const index = buffer.indexOf('\r\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        commands.push(line);
        if (line.startsWith('EHLO')) socket.write('250-localhost\r\n250 HELP\r\n');
        else if (line === 'QUIT') socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  const address = smtp.address();
  if (!address || typeof address === 'string') throw new Error('SMTP测试服务未启动');
  const password = 'mail-browser-saved-password';
  try {
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/subscriptions');
    await expect(page.getByRole('switch', { name: '启动推送' })).not.toBeChecked();
    await page.getByRole('button', { name: '推送配置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '推送配置' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('switch')).toHaveCount(0);
    await dialog.getByLabel('SMTP 地址').fill('127.0.0.1');
    await dialog.getByLabel('端口', { exact: true }).fill(String(address.port));
    await dialog.getByLabel('加密方式').selectOption('none');
    await dialog.getByLabel('账号', { exact: true }).fill('');
    await dialog.getByLabel('密码或授权码').fill(password);
    await dialog.getByLabel('发件人', { exact: true }).fill('数智参阅 <sender@example.invalid>');
    await dialog.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('连接与认证通过');
    expect(commands.some((c) => c.startsWith('EHLO'))).toBe(true);
    expect(commands.some((c) => /^(MAIL FROM|RCPT TO|DATA)/.test(c))).toBe(false);
    expect((await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value).toEqual(
      original,
    );
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value;
    expect(saved.deliveryEnabled).toBe(false);
    expect(saved.mailConnection.password).toBe(password);
    expect(saved.mailConnection.port).toBe(address.port);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('button', { name: '推送配置', exact: true }).click();
      await expect(dialog.getByLabel('密码或授权码')).toHaveValue('');
      await expect(dialog.getByLabel('密码或授权码')).toHaveAttribute(
        'placeholder',
        '已配置，留空保留原值',
      );
      expect(await page.content()).not.toContain(password);
      expect(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
      await page.screenshot({ path: `.data/mail-settings-${width}.png` });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
    await page.getByRole('button', { name: '推送配置', exact: true }).click();
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      (await db.query('SELECT value FROM settings WHERE id=1')).rows[0].value.mailConnection
        .password,
    ).toBe(password);
    await page.getByRole('switch', { name: '启动推送' }).click();
    await expect(page.getByRole('switch', { name: '启动推送' })).toBeChecked();
    await page.getByRole('switch', { name: '启动推送' }).click();
    await expect(page.getByRole('switch', { name: '启动推送' })).not.toBeChecked();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
    await db.query('UPDATE settings SET value=$1 WHERE id=1', [original]);
    await db.end();
  }
});
