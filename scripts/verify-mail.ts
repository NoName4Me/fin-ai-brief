import { pool } from '../src/server/db.ts';
import { getMailConnection } from '../src/server/mail-config.ts';
import { validateMailConnection } from '../src/server/mail-connection.ts';
import { createMailTransport } from '../src/server/mail-transport.ts';
import { mailFailure } from '../src/server/mail-errors.ts';

// Connection verification is available while delivery is paused and never sends mail.
let connection: Awaited<ReturnType<typeof getMailConnection>> | undefined;
try {
  connection = validateMailConnection(await getMailConnection());
  const transport = createMailTransport(connection);
  try {
    await transport.verify();
    console.log('SMTP连接与账号认证通过（未发送邮件）');
  } finally {
    transport.close();
  }
} catch (error) {
  console.error(mailFailure(error, connection ? [connection.password, connection.user] : []).error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
