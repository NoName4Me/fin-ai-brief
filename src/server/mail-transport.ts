import type { MailConnection } from './mail-connection.ts';
import nodemailer from 'nodemailer';
export function createMailTransport(connection: MailConnection) {
  return nodemailer.createTransport({
    host: connection.host,
    port: connection.port,
    secure: connection.security === 'tls',
    requireTLS: connection.security === 'starttls',
    ignoreTLS: connection.security === 'none',
    auth: connection.user ? { user: connection.user, pass: connection.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
  });
}
