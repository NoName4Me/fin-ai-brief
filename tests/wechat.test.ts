import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/server/db.ts';
import { articles, sources, wechatAccounts } from '../src/server/schema.ts';
import { migrate } from '../scripts/migrate.ts';
import { getSettings, saveSettings } from '../src/server/settings.ts';
import { collectSource } from '../src/server/collect.ts';
import { addWechatAccount, saveWechatCredentials } from '../src/server/wechat.ts';
import { getWechatAuthStatus } from '../src/server/wechat.ts';
import { pollWechatLogin, startWechatLogin } from '../src/server/wechat-auth.ts';
import { decryptWechatSecret, encryptWechatSecret } from '../src/modules/wechat/crypto.ts';
import { assertWechatSuccess, WechatError } from '../src/modules/wechat/errors.ts';
import { parseWechatArticle, parseWechatArticleList } from '../src/modules/wechat/parser.ts';
import { saveSourceConfig, toggleSource } from '../src/server/source-config.ts';
import { verifySource } from '../src/server/source-verification.ts';

if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('公众号测试必须连接独立 _test 库');

before(async () => {
  process.env.APP_SECRET = 'wechat-test-secret-with-at-least-32-characters';
  await migrate();
  await pool.query('TRUNCATE articles,sources,wechat_credentials,wechat_login_sessions CASCADE');
});

after(async () => {
  await pool.end();
});

test('微信凭证加密保存且可解密，篡改后不可读取', () => {
  const encrypted = encryptWechatSecret({ token: 'secret-token', cookie: 'session=secret' });
  assert.equal(encrypted.includes('secret-token'), false);
  assert.deepEqual(decryptWechatSecret(encrypted), {
    token: 'secret-token',
    cookie: 'session=secret',
  });
  assert.throws(() => decryptWechatSecret(`${encrypted.slice(0, -2)}xx`));
});

test('解析微信嵌套文章列表并保留原始发布信息', () => {
  const payload = {
    publish_page: JSON.stringify({
      publish_list: [
        {
          publish_info: JSON.stringify({
            appmsgex: [
              {
                aid: '123_1',
                title: '最新文章',
                link: 'https://mp.weixin.qq.com/s/article-id',
                digest: '文章摘要',
                create_time: 1793200000,
              },
            ],
          }),
        },
      ],
    }),
  };
  assert.deepEqual(parseWechatArticleList(payload), [
    {
      aid: '123_1',
      title: '最新文章',
      url: 'https://mp.weixin.qq.com/s/article-id',
      excerpt: '文章摘要',
      publishedAt: new Date(1793200000000).toISOString(),
    },
  ]);
});

test('正文解析移除脚本并识别访问验证', () => {
  const parsed = parseWechatArticle(`
    <h1 id="activity-name">  文章标题 </h1>
    <div id="js_content"><p>第一段正文内容，包含足够的有效文字。</p><script>bad()</script><p>第二段正文内容。</p></div>`);
  assert.equal(parsed.title, '文章标题');
  assert.match(parsed.excerpt, /第一段正文内容/);
  assert.doesNotMatch(parsed.excerpt, /bad/);
  assert.throws(
    () => parseWechatArticle('<html>环境异常，请输入图片中的字符</html>'),
    (error: unknown) => error instanceof WechatError && error.code === 'verification',
  );
});

test('微信登录失效与公众号失效被分类', () => {
  assert.throws(
    () => assertWechatSuccess({ base_resp: { ret: 200003, err_msg: 'invalid session' } }),
    (error: unknown) => error instanceof WechatError && error.code === 'auth',
  );
  assert.throws(
    () => assertWechatSuccess({ base_resp: { ret: 200002, err_msg: 'invalid args' } }),
    (error: unknown) => error instanceof WechatError && error.code === 'invalid_account',
  );
});

test('扫码登录流程保存连接状态且不向页面暴露凭证', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const action = url.searchParams.get('action');
    if (url.pathname === '/cgi-bin/bizlogin' && action === 'startlogin')
      return Response.json(
        { base_resp: { ret: 0 } },
        { headers: { 'Set-Cookie': 'login-session=abc; Path=/; Secure' } },
      );
    if (url.pathname === '/cgi-bin/scanloginqrcode' && action === 'getqrcode') {
      assert.match(
        String(init?.headers && new Headers(init.headers).get('cookie')),
        /login-session=abc/,
      );
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { 'Content-Type': 'image/png' },
      });
    }
    if (url.pathname === '/cgi-bin/scanloginqrcode' && action === 'ask')
      return Response.json({ base_resp: { ret: 0 }, status: 1 });
    if (url.pathname === '/cgi-bin/bizlogin' && action === 'login')
      return Response.json(
        { base_resp: { ret: 0 }, redirect_url: '/cgi-bin/home?token=login-token' },
        { headers: { 'Set-Cookie': 'auth-session=xyz; Path=/; Secure' } },
      );
    if (url.pathname === '/cgi-bin/home')
      return new Response('<script>nick_name = "自己的公众号";</script>');
    if (url.pathname === '/cgi-bin/searchbiz')
      return Response.json({
        base_resp: { ret: 0 },
        list: [{ fakeid: 'owner-id', nickname: '自己的公众号', alias: 'owner' }],
      });
    throw new Error(`未预期的登录请求：${url}`);
  };
  try {
    const login = await startWechatLogin();
    assert.match(login.qrCode, /^data:image\/png;base64,/);
    assert.deepEqual(await pollWechatLogin(login.sessionId), {
      state: 'success',
      message: '公众号连接成功',
      nickname: '自己的公众号',
    });
    const status = await getWechatAuthStatus();
    assert.equal(status.connected, true);
    assert.equal(status.nickname, '自己的公众号');
    assert.equal('token' in status, false);
    assert.equal('cookie' in status, false);
    await assert.rejects(pollWechatLogin(login.sessionId), /二维码已过期/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('公众号新文章读取正文后入库，重复轮询不重复抓取', async () => {
  await saveSettings({ ...(await getSettings()), collectionEnabled: true });
  await saveWechatCredentials({
    token: 'test-token',
    cookie: 'session=test',
    nickname: '登录公众号',
    accountFakeid: 'owner-id',
  });
  const account = await addWechatAccount({
    fakeid: 'target-id',
    nickname: '目标公众号',
    alias: 'target',
    avatarUrl: '',
  });
  const published = Math.floor((Date.now() - 3600_000) / 1000);
  let detailRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/cgi-bin/appmsgpublish') {
      return Response.json({
        base_resp: { ret: 0 },
        publish_page: {
          publish_list: [
            {
              publish_info: {
                appmsgex: [
                  {
                    aid: 'new-1',
                    title: '自动采集文章',
                    link: 'https://mp.weixin.qq.com/s/new-1',
                    digest: '列表摘要',
                    create_time: published,
                  },
                ],
              },
            },
          ],
        },
      });
    }
    if (url.pathname === '/s/new-1') {
      detailRequests += 1;
      assert.equal(url.searchParams.get('token'), 'test-token');
      return new Response(
        '<h1 id="activity-name">自动采集文章</h1><div id="js_content"><p>这是从公众号详情页读取的完整正文，用于后续事实分析与简报生成。</p></div>',
      );
    }
    throw new Error(`未预期的请求：${url}`);
  };
  try {
    assert.deepEqual(
      await collectSource(account.sourceId, undefined, new Date(), { manual: true }),
      {
        fetched: 1,
        inserted: 1,
      },
    );
    assert.deepEqual(
      await collectSource(account.sourceId, undefined, new Date(), { manual: true }),
      {
        fetched: 1,
        inserted: 0,
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(detailRequests, 1);
  const [article] = await db.select().from(articles).where(eq(articles.sourceId, account.sourceId));
  assert.equal(article.title, '自动采集文章');
  assert.equal(article.sourceName, '目标公众号');
  assert.match(article.excerpt, /完整正文/);
  const [source] = await db.select().from(sources).where(eq(sources.id, account.sourceId));
  assert.equal(source.format, 'wechat');
  assert.equal(source.lastError, null);
});

const wechatConfig = {
  name: '统一配置公众号',
  originAddress: 'configured-account',
  url: null,
  format: 'wechat',
  sections: [],
  priority: 'P1',
  verificationStatus: 'pending',
  verificationNote: '',
  notes: '',
  intervalMinutes: 90,
  autoInterval: false,
  minIntervalMinutes: 60,
  maxIntervalMinutes: 240,
  wechatFakeid: 'configured-fakeid',
  wechatNickname: '统一配置公众号',
  wechatAlias: 'configured-account',
  wechatAvatarUrl: '',
};

test('公众号复用统一信源配置、采集节奏和类型切换', async () => {
  const source = await saveSourceConfig(undefined, wechatConfig);
  assert.equal(source.url, 'https://mp.weixin.qq.com/');
  assert.equal(source.catalogKey, 'wechat:configured-fakeid');
  assert.equal(source.readDetails, true);
  assert.equal(source.intervalMinutes, 90);
  assert.equal(source.enabled, false);
  const [account] = await db
    .select()
    .from(wechatAccounts)
    .where(eq(wechatAccounts.sourceId, source.id));
  assert.equal(account.fakeid, 'configured-fakeid');
  await assert.rejects(saveSourceConfig(undefined, wechatConfig), /该公众号已添加/);

  const approved = await saveSourceConfig(source.id, {
    ...wechatConfig,
    verificationStatus: 'approved',
  });
  assert.equal(approved.verificationStatus, 'approved');
  await toggleSource(source.id, true);
  const updated = await saveSourceConfig(source.id, {
    ...wechatConfig,
    verificationStatus: 'approved',
    intervalMinutes: 120,
  });
  assert.equal(updated.intervalMinutes, 120);
  assert.equal(updated.enabled, true);

  const switched = await saveSourceConfig(source.id, {
    ...wechatConfig,
    format: 'manual',
    url: null,
    readDetails: false,
    wechatFakeid: '',
    wechatNickname: '',
  });
  assert.equal(switched.catalogKey, null);
  assert.equal(switched.verificationStatus, 'pending');
  assert.equal(switched.enabled, false);
  assert.equal(
    (
      await db
        .select({ id: wechatAccounts.id })
        .from(wechatAccounts)
        .where(eq(wechatAccounts.sourceId, source.id))
    ).length,
    0,
  );
});

test('公众号验证走微信模块且不导入文章', async () => {
  await saveWechatCredentials({
    token: 'verify-token',
    cookie: 'session=verify-cookie',
    nickname: '登录公众号',
    accountFakeid: 'owner-id',
  });
  const source = await saveSourceConfig(undefined, {
    ...wechatConfig,
    wechatFakeid: 'verify-fakeid',
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/cgi-bin/appmsgpublish')
      return Response.json({
        base_resp: { ret: 0 },
        publish_page: {
          publish_list: [
            {
              publish_info: {
                appmsgex: [
                  {
                    aid: 'verify-1',
                    title: '公众号验证文章',
                    link: 'https://mp.weixin.qq.com/s/verify-1',
                    digest: '列表摘要',
                    create_time: Math.floor((Date.now() - 3600_000) / 1000),
                  },
                ],
              },
            },
          ],
        },
      });
    if (url.pathname === '/s/verify-1')
      return new Response(
        '<div id="js_content"><p>这是用于验证公众号采集配置的完整正文，不会直接导入文章库。</p></div>',
      );
    throw new Error(`未预期的请求：${url}`);
  };
  try {
    const result = await verifySource(source.id, async () => {
      throw new Error('公众号验证不应请求普通采集入口');
    });
    assert.equal(result.status, 'approved');
    assert.match(result.note, /公众号验证文章/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const [saved] = await db.select().from(sources).where(eq(sources.id, source.id));
  assert.equal(saved.verificationStatus, 'approved');
  assert.equal(saved.enabled, false);
  assert.equal(
    (await db.select({ id: articles.id }).from(articles).where(eq(articles.sourceId, source.id)))
      .length,
    0,
  );
});
