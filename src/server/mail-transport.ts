import type { MailConnection } from './mail-connection.ts';
import nodemailer from 'nodemailer';
function transportOptions(connection: MailConnection) {
  return {
    host: connection.host,
    port: connection.port,
    secure: connection.security === 'tls',
    requireTLS: connection.security === 'starttls',
    ignoreTLS: connection.security === 'none',
    auth: connection.user ? { user: connection.user, pass: connection.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
  };
}
export function createMailTransport(connection: MailConnection) {
  return nodemailer.createTransport(transportOptions(connection));
}
export function createPooledMailTransport(connection: MailConnection) {
  return nodemailer.createTransport({
    ...transportOptions(connection),
    pool: true,
    maxConnections: 1,
    maxMessages: 100,
    // 断线后的提交结果可能不明，不能让连接池自行重发。
    maxRequeues: 0,
  });
}
