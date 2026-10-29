import { desc, eq } from 'drizzle-orm';
import { db } from './db.ts';
import { sources, wechatAccounts, wechatCredentials } from './schema.ts';
import { WechatClient } from '../modules/wechat/client.ts';
import { decryptWechatSecret, encryptWechatSecret } from '../modules/wechat/crypto.ts';
import { WechatError } from '../modules/wechat/errors.ts';
import type { WechatAccount, WechatCredentials } from '../modules/wechat/types.ts';
import { saveSourceConfig, toggleSource } from './source-config.ts';

type StoredSecret = { token: string; cookie: string };

export async function saveWechatCredentials(
  input: StoredSecret & {
    nickname: string;
    accountFakeid: string;
  },
) {
  const expiresAt = new Date(Date.now() + 4 * 86_400_000);
  const secret = encryptWechatSecret({ token: input.token, cookie: input.cookie });
  await db
    .insert(wechatCredentials)
    .values({
      id: 1,
      secret,
      nickname: input.nickname,
      accountFakeid: input.accountFakeid,
      expiresAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: wechatCredentials.id,
      set: {
        secret,
        nickname: input.nickname,
        accountFakeid: input.accountFakeid,
        expiresAt,
        updatedAt: new Date(),
      },
    });
}

export async function getWechatAuthStatus() {
  const [row] = await db.select().from(wechatCredentials).where(eq(wechatCredentials.id, 1));
  if (!row || !(row.expiresAt instanceof Date) || !Number.isFinite(row.expiresAt.getTime()))
    return { connected: false, expired: false, nickname: '', expiresAt: null };
  return {
    connected: true,
    expired: row.expiresAt.getTime() <= Date.now(),
    nickname: row.nickname,
    expiresAt: row.expiresAt.toISOString(),
  };
}

async function credentials(): Promise<WechatCredentials> {
  const [row] = await db.select().from(wechatCredentials).where(eq(wechatCredentials.id, 1));
  if (!row) throw new WechatError('请先使用自己的公众号扫码登录', 'auth');
  if (row.expiresAt.getTime() <= Date.now())
    throw new WechatError('微信登录已过期，请重新扫码登录', 'auth');
  const secret = decryptWechatSecret<StoredSecret>(row.secret);
  return {
    ...secret,
    nickname: row.nickname,
    accountFakeid: row.accountFakeid,
    expiresAt: row.expiresAt,
  };
}

async function client() {
  return new WechatClient(await credentials());
}

async function failed(error: unknown): Promise<never> {
  if (error instanceof WechatError && error.code === 'auth')
    await db
      .update(wechatCredentials)
      .set({ expiresAt: new Date(), updatedAt: new Date() })
      .where(eq(wechatCredentials.id, 1));
  throw error;
}

export async function searchWechatAccounts(query: string) {
  try {
    return await (await client()).searchAccounts(query);
  } catch (error) {
    return failed(error);
  }
}

export async function addWechatAccount(account: WechatAccount) {
  const source = await saveSourceConfig(undefined, {
    name: account.nickname,
    originAddress: account.alias || account.nickname,
    url: null,
    format: 'wechat',
    sections: [],
    priority: 'P1',
    verificationStatus: 'approved',
    verificationNote: '公众号接口已配置',
    notes: '',
    intervalMinutes: 60,
    autoInterval: false,
    minIntervalMinutes: 60,
    maxIntervalMinutes: 240,
    wechatFakeid: account.fakeid,
    wechatNickname: account.nickname,
    wechatAlias: account.alias,
    wechatAvatarUrl: account.avatarUrl,
  });
  await toggleSource(source.id, true);
  const [saved] = await db
    .select()
    .from(wechatAccounts)
    .where(eq(wechatAccounts.sourceId, source.id));
  return saved;
}

export async function listWechatAccounts() {
  const rows = await db
    .select({ account: wechatAccounts, source: sources })
    .from(wechatAccounts)
    .innerJoin(sources, eq(sources.id, wechatAccounts.sourceId))
    .orderBy(desc(wechatAccounts.createdAt));
  return rows.map(({ account, source }) => ({
    id: account.id,
    sourceId: account.sourceId,
    fakeid: account.fakeid,
    nickname: account.nickname,
    alias: account.alias,
    avatarUrl: account.avatarUrl,
    enabled: source.enabled,
    intervalMinutes: source.intervalMinutes,
    lastFetchedAt: source.lastFetchedAt?.toISOString() ?? null,
    nextFetchAt: source.nextFetchAt?.toISOString() ?? null,
    lastError: source.lastError,
  }));
}

export async function setWechatAccountEnabled(sourceId: string, enabled: boolean) {
  if (enabled) await credentials();
  const [account] = await db
    .select()
    .from(wechatAccounts)
    .where(eq(wechatAccounts.sourceId, sourceId));
  if (!account) throw new Error('公众号不存在');
  await toggleSource(sourceId, enabled);
  if (enabled) await db.update(sources).set({ lastError: null }).where(eq(sources.id, sourceId));
}

export async function removeWechatAccount(sourceId: string) {
  await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(wechatAccounts)
      .where(eq(wechatAccounts.sourceId, sourceId));
    if (!account) throw new Error('公众号不存在');
    await tx.delete(sources).where(eq(sources.id, sourceId));
  });
}

export async function wechatSourceItems(sourceId: string) {
  const [account] = await db
    .select()
    .from(wechatAccounts)
    .where(eq(wechatAccounts.sourceId, sourceId));
  if (!account) throw new Error('公众号配置不存在');
  try {
    return await (await client()).latestArticles(account.fakeid);
  } catch (error) {
    return failed(error);
  }
}

export async function readWechatSourceDetail(url: string) {
  try {
    return await (await client()).readArticle(url);
  } catch (error) {
    return failed(error);
  }
}

export async function clearWechatCredentials() {
  await db.delete(wechatCredentials).where(eq(wechatCredentials.id, 1));
}
