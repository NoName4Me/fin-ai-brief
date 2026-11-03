import { z } from 'zod';

export const mailConnectionSchema = z.object({
  host: z.string().trim().max(253).default(''),
  port: z.number().int().min(1).max(65535).default(465),
  security: z.enum(['tls', 'starttls', 'none']).default('tls'),
  user: z.string().trim().max(254).default(''),
  password: z.string().max(4000).default(''),
  from: z.string().trim().max(500).default(''),
});
export type MailConnection = z.infer<typeof mailConnectionSchema>;
export type PublicMailConnection = Omit<MailConnection, 'password'> & {
  passwordConfigured: boolean;
};

export function mailConnectionFromEnvironment(): MailConnection {
  return {
    host: process.env.SMTP_HOST?.trim() ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    security: process.env.SMTP_SECURE === 'true' ? 'tls' : 'starttls',
    user: process.env.SMTP_USER?.trim() ?? '',
    password: process.env.SMTP_PASSWORD ?? '',
    from: process.env.MAIL_FROM?.trim() ?? '',
  };
}
export function validateMailConnection(input: unknown) {
  const value = mailConnectionSchema.parse(input);
  if (!value.host || !/^[a-z0-9.-]+$/i.test(value.host))
    throw new Error('SMTP 地址只填写服务器域名，不含协议和端口');
  const address = value.from.match(/^(?:[^<>\r\n]+<)?([^<>\s]+@[^<>\s]+)>?$/)?.[1];
  if (!address || !z.email().safeParse(address).success || /[\r\n]/.test(value.from))
    throw new Error('请填写有效的发件人邮箱，可使用“名称 <邮箱>”格式');
  if (value.user && !value.password) throw new Error('请填写密码或授权码');
  return value;
}
