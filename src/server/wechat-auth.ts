import { randomUUID } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { db } from './db.ts';
import { wechatLoginSessions } from './schema.ts';
import { saveWechatCredentials } from './wechat.ts';
import { decryptWechatSecret, encryptWechatSecret } from '../modules/wechat/crypto.ts';
import { assertWechatSuccess, WechatError } from '../modules/wechat/errors.ts';
import { WechatHttpClient, type CookieJar } from '../modules/wechat/http.ts';
import { parseWechatAccounts, parseWechatNickname } from '../modules/wechat/parser.ts';
import type { WechatLoginStatus } from '../modules/wechat/types.ts';

async function saveSession(id: string, http: WechatHttpClient, expiresAt: Date) {
  if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()))
    throw new WechatError('扫码登录状态无效，请重新获取二维码');
  await db
    .insert(wechatLoginSessions)
    .values({ id, secret: encryptWechatSecret(http.cookies), expiresAt })
    .onConflictDoUpdate({
      target: wechatLoginSessions.id,
      set: { secret: encryptWechatSecret(http.cookies), expiresAt },
    });
}

export async function startWechatLogin() {
  await db.delete(wechatLoginSessions).where(lt(wechatLoginSessions.expiresAt, new Date()));
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const http = new WechatHttpClient();
  const started = await http.json('/cgi-bin/bizlogin', {
    method: 'POST',
    params: { action: 'startlogin' },
    form: {
      userlang: 'zh_CN',
      redirect_url: '',
      login_type: 3,
      sessionid: id,
      token: '',
      lang: 'zh_CN',
      f: 'json',
      ajax: 1,
    },
  });
  assertWechatSuccess(started);
  const qr = await http.request('/cgi-bin/scanloginqrcode', {
    params: { action: 'getqrcode', random: Date.now() },
  });
  const png = qr.body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const jpeg = qr.body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (!png && !jpeg && !qr.contentType.startsWith('image/'))
    throw new WechatError('微信二维码获取失败，请稍后重试');
  await saveSession(id, http, expiresAt);
  return {
    sessionId: id,
    qrCode: `data:${png ? 'image/png' : jpeg ? 'image/jpeg' : qr.contentType};base64,${qr.body.toString('base64')}`,
  };
}

async function completeLogin(http: WechatHttpClient) {
  const payload = await http.json('/cgi-bin/bizlogin', {
    method: 'POST',
    params: { action: 'login' },
    form: {
      userlang: 'zh_CN',
      redirect_url: '',
      cookie_forbidden: 0,
      cookie_cleaned: 0,
      plugin_used: 0,
      login_type: 3,
      token: '',
      lang: 'zh_CN',
      f: 'json',
      ajax: 1,
    },
  });
  assertWechatSuccess(payload);
  const redirectUrl = (payload as { redirect_url?: string }).redirect_url;
  const token = redirectUrl
    ? new URL(redirectUrl, 'https://mp.weixin.qq.com').searchParams.get('token')
    : null;
  if (!token) throw new WechatError('微信登录成功但未返回凭证', 'format');
  const cookie = http.cookieHeader();
  const home = await http.request('/cgi-bin/home', {
    params: { t: 'home/index', token, lang: 'zh_CN' },
  });
  const nickname = parseWechatNickname(home.body.toString('utf8')) || '已连接公众号';
  let accountFakeid = '';
  const search = await http.json('/cgi-bin/searchbiz', {
    params: {
      action: 'search_biz',
      token,
      lang: 'zh_CN',
      f: 'json',
      ajax: 1,
      random: Date.now(),
      query: nickname,
      begin: 0,
      count: 5,
    },
  });
  assertWechatSuccess(search);
  const accounts = parseWechatAccounts(search);
  accountFakeid =
    (accounts.find((account) => account.nickname === nickname) ?? accounts[0])?.fakeid ?? '';
  await saveWechatCredentials({ token, cookie, nickname, accountFakeid });
  return nickname;
}

export async function pollWechatLogin(id: string): Promise<WechatLoginStatus> {
  const [session] = await db
    .select()
    .from(wechatLoginSessions)
    .where(eq(wechatLoginSessions.id, id));
  if (
    !session ||
    !(session.expiresAt instanceof Date) ||
    !Number.isFinite(session.expiresAt.getTime()) ||
    session.expiresAt.getTime() <= Date.now()
  ) {
    if (session) await db.delete(wechatLoginSessions).where(eq(wechatLoginSessions.id, id));
    throw new WechatError('二维码已过期，请重新获取');
  }
  const http = new WechatHttpClient(decryptWechatSecret<CookieJar>(session.secret));
  const payload = await http.json('/cgi-bin/scanloginqrcode', {
    params: { action: 'ask', token: '', lang: 'zh_CN', f: 'json', ajax: 1 },
  });
  assertWechatSuccess(payload);
  const status = Number((payload as { status?: number }).status ?? 0);
  if (status === 1) {
    const nickname = await completeLogin(http);
    await db.delete(wechatLoginSessions).where(eq(wechatLoginSessions.id, id));
    return { state: 'success', message: '公众号连接成功', nickname };
  }
  if (status === 2) throw new WechatError('二维码已过期，请重新获取');
  if (status === 3) throw new WechatError('扫码登录失败，请重新获取二维码');
  await saveSession(id, http, session.expiresAt);
  if ([4, 6].includes(status)) return { state: 'scanned', message: '已扫码，请在手机上确认登录' };
  return { state: 'waiting', message: '请使用微信扫描二维码' };
}
