import { requireMailConfig } from '../src/server/mail-config.ts';
import { createMailTransport } from '../src/server/mail-transport.ts';
import { mailFailure } from '../src/server/mail-errors.ts';
// 只检查连接、TLS及认证，不发送邮件，也不修改投递记录。
requireMailConfig();
const transport = createMailTransport();
try {
  await transport.verify();
  console.log('SMTP连接、加密及账号认证通过（未发送邮件）');
} catch (error) {
  console.error(mailFailure(error).error);
  process.exitCode = 1;
} finally {
  transport.close();
}
