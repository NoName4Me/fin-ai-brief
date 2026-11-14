import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { SendMailOptions } from 'nodemailer';
import { pool } from './db.ts';
import type { MailConnection } from './mail-connection.ts';
import { createPooledMailTransport } from './mail-transport.ts';

const sendIntervalMs = 5_000;
const authCooldownMs = 15 * 60_000;
const idleTimeoutMs = 60_000;
type CachedTransport = {
  transport: ReturnType<typeof createPooledMailTransport>;
  idleTimer?: NodeJS.Timeout;
};
const transports = new Map<string, CachedTransport>();

export class MailCooldown extends Error {
  constructor(readonly until: Date) {
    super(
      `SMTP认证冷却中，${until.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}后继续投递`,
    );
  }
}

function closeTransport(key: string) {
  const cached = transports.get(key);
  if (!cached) return;
  clearTimeout(cached.idleTimer);
  cached.transport.close();
  transports.delete(key);
}

export function closeMailTransports() {
  for (const key of transports.keys()) closeTransport(key);
}

function connectionKey(connection: MailConnection) {
  // 不含发件人显示名；更换服务器、账号或凭据后使用新的连接与冷却状态。
  return createHash('sha256')
    .update(
      JSON.stringify([
        connection.host,
        connection.port,
        connection.security,
        connection.user,
        connection.password,
      ]),
    )
    .digest('hex');
}

async function sendPooled(key: string, connection: MailConnection, message: SendMailOptions) {
  let cached = transports.get(key);
  if (!cached) {
    cached = { transport: createPooledMailTransport(connection) };
    transports.set(key, cached);
  }
  clearTimeout(cached.idleTimer);
  try {
    const result = await cached.transport.sendMail(message);
    cached.idleTimer = setTimeout(() => closeTransport(key), idleTimeoutMs);
    cached.idleTimer.unref();
    return result;
  } catch (error) {
    closeTransport(key);
    throw error;
  }
}

export async function sendMail(connection: MailConnection, message: SendMailOptions) {
  const key = connectionKey(connection);
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query(
      'INSERT INTO mail_send_runtime(connection_key) VALUES($1) ON CONFLICT DO NOTHING',
      [key],
    );
    // 同一账号的Web、Worker及多个进程共用锁；锁内只做SMTP操作，不获取其他数据库连接。
    const {
      rows: [runtime],
    } = await client.query<{ next_send_at: Date; cooldown_until: Date | null }>(
      'SELECT next_send_at,cooldown_until FROM mail_send_runtime WHERE connection_key=$1 FOR UPDATE',
      [key],
    );
    const {
      rows: [clock],
    } = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    if (runtime.cooldown_until && runtime.cooldown_until > clock.now) {
      closeTransport(key);
      throw new MailCooldown(runtime.cooldown_until);
    }
    const wait = runtime.next_send_at.getTime() - clock.now.getTime();
    if (wait > 0) await delay(Math.min(wait, sendIntervalMs));
    // 捕获错误后先提交冷却状态，再向调用方抛出原始SMTP错误。
    let outcome;
    try {
      outcome = { ok: true as const, result: await sendPooled(key, connection, message) };
    } catch (error) {
      outcome = { ok: false as const, error };
    }
    const error = !outcome.ok ? outcome.error : null;
    const authFailure =
      !!error &&
      typeof error === 'object' &&
      (('code' in error && error.code === 'EAUTH') ||
        ('responseCode' in error && error.responseCode === 535));
    await client.query(
      `UPDATE mail_send_runtime SET next_send_at=clock_timestamp()+$2*interval '1 millisecond',
       cooldown_until=CASE WHEN $3::boolean THEN clock_timestamp()+$4*interval '1 millisecond' ELSE NULL END
       WHERE connection_key=$1`,
      [key, sendIntervalMs, authFailure, authCooldownMs],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    if (!outcome.ok) throw outcome.error;
    return outcome.result;
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
