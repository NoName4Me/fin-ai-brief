export function requireMailConfig() {
  if (process.env.MAIL_ENABLED !== 'true') throw new Error('邮件发送尚未启用，请先完成发信配置');
  if (!process.env.SMTP_HOST || !process.env.MAIL_FROM)
    throw new Error('请先配置 SMTP_HOST 和 MAIL_FROM');
  if (process.env.SMTP_HOST.includes('://'))
    throw new Error('SMTP_HOST 只填写服务器域名，不含 https://');
  const port = Number(process.env.SMTP_PORT ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT 配置无效');
  if (process.env.SMTP_USER && !process.env.SMTP_PASSWORD)
    throw new Error('请先配置 SMTP_PASSWORD');
  if (!process.env.APP_SECRET || process.env.APP_SECRET.length < 32)
    throw new Error('APP_SECRET 需要至少32位随机字符串');
  try {
    const url = new URL(process.env.SITE_URL ?? '');
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error('请先配置有效的 SITE_URL');
  }
}
export function mailConfigError() {
  try {
    requireMailConfig();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : '邮件配置无效';
  }
}
