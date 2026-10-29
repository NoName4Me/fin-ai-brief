import { pool } from './db.ts';
import { reserveHost } from './source-rhythm.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { sourceRequestUrl, sourceRequestOptions } from './source-access.ts';
import { structuredRequestOptions, type StructuredRequestContext } from './structured-sources.ts';
import { lookup } from 'node:dns/promises';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { isIP } from 'node:net';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { constants } from 'node:crypto';
// 少数官方站点仍要求已废弃的 TLS 重协商；默认禁用，仅在该握手失败时重试一次。
export function needsLegacyRenegotiation(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return /unsafe legacy renegotiation|legacy renegotiation|EPROTO/i.test(message);
}
export function publicAddress(ip: string, allowFakeIp = false) {
  const v = ip.toLowerCase();
  if (v.includes(':')) return !(/^(::|fe[89ab]|f[cd]|ff)/.test(v) || v.includes('ffff:'));
  const [a, b] = v.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224 ||
    (a === 198 && (b === 18 || b === 19) && !allowFakeIp)
  );
}
async function resolveRemote(input: string) {
  const url = new URL(input);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !['', '80', '443'].includes(url.port)
  )
    throw new Error('信源必须是标准 HTTP(S) 公开地址');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (
    !addresses.length ||
    addresses.some(
      (a) =>
        !publicAddress(a.address, !isIP(host) && process.env.SOURCE_FAKE_IP_ENABLED === 'true'),
    )
  )
    throw new Error('信源地址不可指向内网或本机');
  return { url, address: addresses[0] };
}
export async function validateRemoteUrl(input: string) {
  return (await resolveRemote(input)).url;
}
export type SourceHeaders = { etag: string | null };
export type SourceFetchOptions = {
  binaryBase64?: boolean;
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  etag?: string | null;
  onHeaders?: (headers: SourceHeaders) => void;
  structuredContext?: StructuredRequestContext;
};
export class SourceHttpError extends Error {
  constructor(
    public status: number,
    public retryAt: Date | null,
  ) {
    super(`信源返回 HTTP ${status}`);
  }
}
export async function fetchSource(input: string, options: SourceFetchOptions = {}) {
  let next = sourceRequestUrl(input);
  const plan = {
    ...structuredRequestOptions(input, options.structuredContext),
    ...sourceRequestOptions(input),
  };
  let method = options.method ?? plan.method ?? 'GET';
  let requestBody = options.body ?? plan.body;
  const origin = new URL(next).origin;
  for (let n = 0; n < 4; n++) {
    const { url, address } = await resolveRemote(next);
    const slot = await reserveHost(url.hostname);
    if (slot.blockedUntil) throw new SourceHttpError(429, slot.blockedUntil);
    if (slot.wait) await delay(slot.wait);
    // 连接固定使用刚刚校验过的地址，避免DNS在校验后改指向内网。
    const send = (legacyRenegotiation: boolean) =>
      new Promise<IncomingMessage>((resolve, reject) => {
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
          url,
          {
            agent: false,
            method,
            family: address.family,
            lookup: (_host, _options, callback) => callback(null, address.address, address.family),
            signal: AbortSignal.timeout(30_000),
            ...(legacyRenegotiation
              ? { secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT }
              : {}),
            headers: {
              'User-Agent': 'FinAiBrief/1.0',
              ...(url.origin === origin ? { ...plan.headers, ...options.headers } : {}),
              'Accept-Encoding': 'gzip, br',
              ...(options.etag ? { 'If-None-Match': options.etag } : {}),
              Accept:
                'application/rss+xml, application/atom+xml, application/json, application/xml, text/xml, text/html, */*;q=0.8',
            },
          },
          resolve,
        );
        request.on('error', reject);
        request.end(requestBody);
      });
    const response = await send(false).catch((error) => {
      if (url.protocol !== 'https:' || !needsLegacyRenegotiation(error)) throw error;
      return send(true);
    });
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      if (!location) throw new Error('信源重定向缺少地址');
      next = new URL(location, url).href;
      if ([301, 302, 303].includes(status)) {
        method = 'GET';
        requestBody = undefined;
      }
      continue;
    }
    options.onHeaders?.({
      etag: typeof response.headers.etag === 'string' ? response.headers.etag : null,
    });
    if (status === 304) {
      response.destroy();
      return null;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      const retry = response.headers['retry-after'];
      const retryAt =
        typeof retry === 'string'
          ? /^\d+$/.test(retry)
            ? new Date(Date.now() + Number(retry) * 1000)
            : new Date(retry)
          : null;
      if (status === 429)
        await pool.query('UPDATE source_hosts SET blocked_until=$2 WHERE host=$1', [
          url.hostname,
          retryAt && !Number.isNaN(retryAt.getTime())
            ? retryAt
            : new Date(Date.now() + 30 * 60_000),
        ]);
      throw new SourceHttpError(
        status,
        retryAt && !Number.isNaN(retryAt.getTime()) ? retryAt : null,
      );
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 3_000_000) throw new Error('信源内容超过3MB');
        chunks.push(bytes);
      }
    } finally {
      response.destroy();
    }
    const rawBody = Buffer.concat(chunks);
    const encoding = response.headers['content-encoding'];
    const body =
      encoding === 'gzip'
        ? gunzipSync(rawBody, { maxOutputLength: 3_000_000 })
        : encoding === 'br'
          ? brotliDecompressSync(rawBody, { maxOutputLength: 3_000_000 })
          : rawBody;
    if (options.binaryBase64) return body.toString('base64');
    const charset =
      /charset=["']?([\w-]+)/i.exec(String(response.headers['content-type']))?.[1] ??
      /<\?xml[^>]*encoding=["']([\w-]+)/i.exec(body.subarray(0, 200).toString('ascii'))?.[1] ??
      'utf-8';
    return new TextDecoder(charset).decode(body);
  }
  throw new Error('信源重定向次数过多');
}
