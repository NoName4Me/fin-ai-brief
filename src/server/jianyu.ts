import { constants, createDecipheriv, createPrivateKey, privateDecrypt } from 'node:crypto';
import { z } from 'zod';
import { localDate, rangeFor } from './periods.ts';

export const jianyuSearchUrl = 'https://www.jianyu360.cn/jyapi/jybx/core/fType/searchList';
const jianyuReferer =
  'https://www.jianyu360.cn/jylab/supsearch/index.html?keywords=%E5%A4%A7%E6%A8%A1%E5%9E%8B&seopage=1';
const jianyuUserAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

export function isJianyuSearch(input: string) {
  try {
    const url = new URL(input);
    return (
      url.origin === 'https://www.jianyu360.cn' &&
      url.pathname === '/jyapi/jybx/core/fType/searchList'
    );
  } catch {
    return false;
  }
}

export function jianyuPublishTime(now: Date, dailyTime: string) {
  const date = localDate(now);
  const todayCutoff = new Date(`${date}T${dailyTime}:00+08:00`);
  const issueDate =
    now >= todayCutoff ? localDate(new Date(todayCutoff.getTime() + 86400_000)) : date;
  const range = rangeFor('daily', issueDate, dailyTime);
  return `${Math.floor(range.start.getTime() / 1000)}-${Math.floor(range.end.getTime() / 1000) - 1}`;
}

export function jianyuRequestOptions(now: Date, dailyTime: string) {
  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    referer: jianyuReferer,
    origin: 'https://www.jianyu360.cn',
    'user-agent': jianyuUserAgent,
  };
  const cookie = process.env.JIANYU_COOKIE?.trim();
  if (cookie) headers.cookie = cookie;
  return {
    method: 'POST' as const,
    headers,
    body: JSON.stringify({
      searchGroup: 1,
      reqType: 'lastNews',
      pageNum: 1,
      pageSize: 50,
      keyWords: '',
      searchMode: 0,
      additionalWords: '大模型,智能体,知识库,AI',
      wordsMode: 0,
      bidField: '',
      publishTime: jianyuPublishTime(now, dailyTime),
      selectType: 'title,content',
      subtype: '',
      exclusionWords: '',
      buyer: '',
      winner: '',
      agency: '',
      industry: '',
      province: '',
      city: '',
      district: '',
      buyerClass: '',
      fileExists: '',
      price: '',
      buyerTel: '',
      winnerTel: '',
      basicClass: '',
      deadlineType: '',
    }),
  };
}

let cachedKey: { source: string; key: ReturnType<typeof createPrivateKey> } | null = null;
function privateKey() {
  const source = process.env.JIANYU_RSA_PRIVATE_KEY?.trim();
  if (!source) throw new Error('尚未配置剑鱼标讯RSA私钥');
  if (cachedKey?.source === source) return cachedKey.key;
  const body = source.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const label = `PRIVATE ${'KEY'}`;
  const pem = `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g)?.join('\n')}\n-----END ${label}-----`;
  const key = createPrivateKey(pem);
  cachedKey = { source, key };
  return key;
}

function decryptJianyuResponse(text: string): unknown {
  const raw = z
    .object({
      antiEncrypt: z.union([z.boolean(), z.number()]).optional(),
      data: z.unknown().optional(),
      secretKey: z.unknown().optional(),
    })
    .passthrough()
    .parse(JSON.parse(text));
  if (!raw.antiEncrypt) return raw;
  if (typeof raw.secretKey !== 'string' || typeof raw.data !== 'string')
    throw new Error('剑鱼标讯返回了加密响应，但缺少 secretKey 或 data');

  const block = privateDecrypt(
    { key: privateKey(), padding: constants.RSA_NO_PADDING },
    Buffer.from(raw.secretKey, 'base64'),
  );
  const delimiter = block.indexOf(0, 2);
  if (block[0] !== 0 || block[1] !== 2 || delimiter < 10)
    throw new Error('剑鱼标讯 RSA 密钥可能已轮换');
  const aesKey = block.subarray(delimiter + 1);
  if (![16, 24, 32].includes(aesKey.length))
    throw new Error(`剑鱼标讯返回了异常 AES 密钥长度：${aesKey.length}`);

  const encrypted = Buffer.from(raw.data, 'base64');
  if (encrypted.length <= 16) throw new Error('剑鱼标讯加密响应缺少 AES counter');
  const decipher = createDecipheriv(
    `aes-${aesKey.length * 8}-ctr`,
    aesKey,
    encrypted.subarray(0, 16),
  );
  const plaintext = Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

export function jianyuItems(text: string) {
  const response = z
    .object({
      antiVerify: z.number().optional(),
      hasLogin: z.boolean().optional(),
    })
    .passthrough()
    .parse(decryptJianyuResponse(text));
  if (response.antiVerify === -1)
    throw new Error(
      response.hasLogin
        ? '剑鱼标讯触发访问验证，请稍后重试'
        : '剑鱼标讯要求登录态，请更新 JIANYU_COOKIE',
    );
  const body = z
    .object({
      error_code: z.number().optional(),
      error_msg: z.string().optional(),
      data: z.object({
        list: z
          .array(
            z.object({
              id: z.string().min(1),
              title: z.string(),
              detail: z.string().nullable().optional(),
              publishTime: z.coerce.number(),
            }),
          )
          .nullable()
          .transform((value) => value ?? []),
      }),
    })
    .parse(response);
  if (body.error_code && body.error_code !== 0)
    throw new Error(`剑鱼标讯接口错误：${body.error_msg || body.error_code}`);
  return body.data.list.flatMap((row) => {
    const publishedAt = new Date(row.publishTime * 1000);
    if (Number.isNaN(publishedAt.getTime())) return [];
    const title = row.title.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!title) return [];
    return [
      {
        title,
        url: `https://www.jianyu360.cn/nologin/content/${row.id}.html`,
        excerpt: (row.detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 16000) || title,
        publishedAt: publishedAt.toISOString(),
        publishedPrecision: 'time' as const,
      },
    ];
  });
}
