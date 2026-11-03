import { test, before, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { pool } from '../src/server/db.ts';
import { migrate } from '../scripts/migrate.ts';
import { defaultSettings } from '../src/server/types.ts';
import { getSettings, saveSettings, saveSettingsPatch } from '../src/server/settings.ts';
import { saveMailSettings, testMailConnection } from '../src/server/mail-settings.ts';
import { getMailConnection, requireMailConfig } from '../src/server/mail-config.ts';
import {
  requestSubscription,
  resendSubscriptionConfirmation,
} from '../src/server/subscription-confirmation.ts';

if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('必须使用独立_test数据库');
const connection = {
  host: 'smtp.example.invalid',
  port: 465,
  security: 'tls' as const,
  user: 'sender@example.invalid',
  password: 'stored-password',
  from: '数智参阅 <sender@example.invalid>',
};
function form(overrides: Record<string, string> = {}) {
  const values = {
    smtpHost: connection.host,
    smtpPort: '465',
    smtpSecurity: 'tls',
    smtpUser: connection.user,
    smtpPassword: '',
    mailFrom: connection.from,
    ...overrides,
  };
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  return result;
}
before(migrate);
beforeEach(async () => {
  mock.restoreAll();
  await pool.query('TRUNCATE subscription_confirmations,subscriptions CASCADE');
  await saveSettings({ ...defaultSettings, deliveryEnabled: true, mailConnection: connection });
  process.env.APP_SECRET = 'mail-settings-test-secret-at-least-32-characters';
  process.env.SITE_URL = 'https://brief.example.invalid';
});
after(async () => {
  mock.restoreAll();
  await pool.end();
});
test('邮件配置立即生效，留空保留密码，保存不覆盖推送开关和其他设置', async () => {
  await saveSettingsPatch({ deliveryEnabled: false, modelDailyLimit: 123 });
  await saveMailSettings(
    form({ smtpHost: 'smtp.changed.invalid', smtpPort: '587', smtpSecurity: 'starttls' }),
  );
  const saved = await getSettings();
  assert.equal(saved.deliveryEnabled, false);
  assert.equal(saved.modelDailyLimit, 123);
  assert.equal(saved.mailConnection?.password, connection.password);
  assert.equal(saved.mailConnection?.host, 'smtp.changed.invalid');
  await saveSettingsPatch({ deliveryEnabled: true });
  process.env.MAIL_ENABLED = 'false';
  process.env.SMTP_HOST = 'ignored.invalid';
  assert.equal((await requireMailConfig()).host, 'smtp.changed.invalid');
});
test('配置无效时整次拒绝保存', async () => {
  const before = await getMailConnection();
  const invalidForms: Record<string, string>[] = [
    { smtpPort: '70000' },
    { smtpHost: 'https://invalid.example' },
    { mailFrom: 'sender@example.invalid\r\nBcc:other@example.invalid' },
  ];
  for (const invalid of invalidForms) {
    await assert.rejects(saveMailSettings(form(invalid)));
    assert.deepEqual(await getMailConnection(), before);
  }
});
test('连接测试使用未保存的表单，推送关闭仍可测试，不发送邮件、不保存配置，错误脱敏并关闭连接', async () => {
  await saveSettingsPatch({ deliveryEnabled: false });
  let verifyCount = 0,
    closed = 0,
    sendCount = 0;
  let fail = false;
  mock.method(nodemailer, 'createTransport', (options: unknown) => {
    assert.deepEqual((options as { auth: unknown }).auth, {
      user: connection.user,
      pass: connection.password,
    });
    assert.equal((options as { host: string }).host, 'smtp.temporary.invalid');
    return {
      verify: async () => {
        verifyCount++;
        if (fail)
          throw Object.assign(
            new Error(
              `bad ${connection.password} ${Buffer.from(connection.password).toString('base64')}`,
            ),
            { code: 'EAUTH' },
          );
      },
      sendMail: async () => {
        sendCount++;
      },
      close: () => {
        closed++;
      },
    };
  });
  await testMailConnection(form({ smtpHost: 'smtp.temporary.invalid' }));
  fail = true;
  await assert.rejects(
    testMailConnection(form({ smtpHost: 'smtp.temporary.invalid' })),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(connection.password));
      assert.ok(!error.message.includes(Buffer.from(connection.password).toString('base64')));
      return true;
    },
  );
  assert.equal(verifyCount, 2);
  assert.equal(sendCount, 0);
  assert.equal(closed, 2);
  assert.deepEqual(await getMailConnection(), connection);
});
test('单一推送开关同时阻止申请和重发订阅确认信', async () => {
  await saveSettingsPatch({ deliveryEnabled: false });
  let calls = 0;
  mock.method(nodemailer, 'createTransport', () => {
    calls++;
    throw new Error('不应连接');
  });
  await assert.rejects(
    requestSubscription({ email: 'reader@example.invalid', kinds: ['daily'] }),
    /推送已暂停/,
  );
  await assert.rejects(resendSubscriptionConfirmation('reader@example.invalid'), /推送已暂停/);
  assert.equal(calls, 0);
});
test('迁移只导入一次邮件环境配置，合并旧开关且不覆盖页面修改', async () => {
  await pool.query(
    "UPDATE settings SET value=(value-'mailConnection') || '{\"deliveryEnabled\":true}'::jsonb WHERE id=1",
  );
  Object.assign(process.env, {
    MAIL_ENABLED: 'false',
    SMTP_HOST: connection.host,
    SMTP_PORT: '465',
    SMTP_SECURE: 'true',
    SMTP_USER: connection.user,
    SMTP_PASSWORD: connection.password,
    MAIL_FROM: connection.from,
  });
  await migrate();
  assert.deepEqual(await getMailConnection(), connection);
  assert.equal((await getSettings()).deliveryEnabled, false);
  await saveMailSettings(
    form({ smtpHost: 'smtp.saved.invalid', smtpPassword: 'new-saved-password' }),
  );
  process.env.MAIL_ENABLED = 'true';
  process.env.SMTP_PASSWORD = 'changed-environment-password';
  await migrate();
  assert.equal((await getMailConnection()).host, 'smtp.saved.invalid');
  assert.equal((await getMailConnection()).password, 'new-saved-password');
  assert.equal((await getSettings()).deliveryEnabled, false);
});
