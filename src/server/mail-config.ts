import { getSettings } from './settings.ts';
import { mailConnectionSchema, validateMailConnection } from './mail-connection.ts';

export async function getMailConnection() {
  const config = await getSettings();
  return mailConnectionSchema.parse(config.mailConnection ?? {});
}
export async function requireMailConfig() {
  const config = await getSettings();
  if (!config.deliveryEnabled) throw new Error('推送已暂停，请先开启推送');
  const connection = validateMailConnection(config.mailConnection ?? {});
  if (!process.env.APP_SECRET || process.env.APP_SECRET.length < 32)
    throw new Error('APP_SECRET 需要至少32位随机字符串');
  try {
    const url = new URL(process.env.SITE_URL ?? '');
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error('请先配置有效的 SITE_URL');
  }
  return connection;
}
export async function mailConfigError() {
  try {
    await requireMailConfig();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : '邮件配置无效';
  }
}
