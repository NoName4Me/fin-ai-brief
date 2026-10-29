import { WechatError } from './errors.ts';

export const WECHAT_BASE_URL = 'https://mp.weixin.qq.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export type CookieJar = Record<string, string>;

export function parseCookieHeader(value: string): CookieJar {
  return Object.fromEntries(
    value
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.includes('='))
      .map((part) => {
        const index = part.indexOf('=');
        return [part.slice(0, index), part.slice(index + 1)];
      }),
  );
}

export class WechatHttpClient {
  constructor(public cookies: CookieJar = {}) {}

  cookieHeader() {
    return Object.entries(this.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  async request(
    path: string,
    options: {
      method?: 'GET' | 'POST';
      params?: Record<string, string | number>;
      form?: Record<string, string | number>;
    } = {},
  ) {
    const url = new URL(path, WECHAT_BASE_URL);
    for (const [name, value] of Object.entries(options.params ?? {}))
      url.searchParams.set(name, String(value));
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Referer: `${WECHAT_BASE_URL}/`,
        Origin: WECHAT_BASE_URL,
        ...(this.cookieHeader() ? { Cookie: this.cookieHeader() } : {}),
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: options.form
        ? new URLSearchParams(
            Object.entries(options.form).map(([name, value]) => [name, String(value)]),
          )
        : undefined,
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
      cache: 'no-store',
    }).catch((error) => {
      throw new WechatError(`微信请求失败：${error instanceof Error ? error.message : '网络异常'}`);
    });
    for (const cookie of response.headers.getSetCookie()) {
      const first = cookie.split(';', 1)[0];
      const index = first.indexOf('=');
      if (index > 0) this.cookies[first.slice(0, index).trim()] = first.slice(index + 1).trim();
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > 5_000_000) throw new WechatError('微信响应内容过大');
    if (!response.ok) throw new WechatError(`微信返回 HTTP ${response.status}`);
    return {
      body,
      contentType: response.headers.get('content-type') ?? '',
    };
  }

  async json(path: string, options: Parameters<WechatHttpClient['request']>[1] = {}) {
    const { body } = await this.request(path, options);
    try {
      return JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      throw new WechatError('微信登录状态无效或接口返回格式已变化', 'auth');
    }
  }
}
