import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/server/db.ts';
import { sources, articles } from '../src/server/schema.ts';
import { getSettings, saveSettings } from '../src/server/settings.ts';
import { migrate } from '../scripts/migrate.ts';
import { collectSource } from '../src/server/collect.ts';
if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('采集测试必须连接独立 _test 库');
before(async () => {
  await migrate();
  await pool.query('TRUNCATE articles,sources CASCADE');
});
after(async () => {
  await pool.end();
});
test('RSS采集保留明确时区、缺省按北京时间，跳过缺失日期且重复不新增', async () => {
  await saveSettings({ ...(await getSettings()), collectionEnabled: true });
  const [source] = await db
    .insert(sources)
    .values({
      name: '本地RSS测试',
      url: 'https://example.invalid/feed',
      format: 'rss',
      industryId: 'finance',
      enabled: true,
    })
    .returning();
  const rss = async () =>
    `<rss version="2.0"><channel><title>Test</title><link>https://example.invalid</link><description>local fixture</description><item><title>有日期</title><link>https://example.invalid/rss/1</link><description>来源摘要</description><pubDate>Thu, 22 Oct 2026 07:30:00 +0800</pubDate></item><item><title>无日期</title><link>https://example.invalid/rss/2</link></item><item><title>缺少时区</title><link>https://example.invalid/rss/3</link><pubDate>2026-10-22 07:30:00</pubDate></item></channel></rss>`;
  assert.deepEqual(await collectSource(source.id, rss, new Date('2026-10-23T00:00:00Z')), {
    fetched: 2,
    inserted: 2,
  });
  assert.deepEqual(await collectSource(source.id, rss, new Date('2026-10-23T00:00:00Z')), {
    fetched: 2,
    inserted: 0,
  });
  const [article] = await db.select().from(articles).where(eq(articles.sourceId, source.id));
  assert.equal(article.publishedAt.toISOString(), '2026-10-21T23:30:00.000Z');
  const imported = await db.select().from(articles).where(eq(articles.sourceId, source.id));
  assert.equal(imported.length, 2);
  assert.ok(imported.every((row) => row.publishedAt.toISOString() === '2026-10-21T23:30:00.000Z'));
  const [saved] = await db.select().from(sources).where(eq(sources.id, source.id));
  assert.ok(saved.lastFetchedAt);
  assert.equal(saved.lastError, null);
});
test('采集开关关闭时不会访问源；失败可在信源管理中看到', async () => {
  const [source] = await db
    .insert(sources)
    .values({
      name: '错误测试',
      url: 'https://example.invalid/error',
      format: 'json',
      industryId: 'ai',
      enabled: true,
    })
    .returning();
  await saveSettings({ ...(await getSettings()), collectionEnabled: false });
  let called = false;
  await assert.rejects(
    () =>
      collectSource(source.id, async () => {
        called = true;
        return '[]';
      }),
    /未开启/,
  );
  assert.equal(called, false);
  await saveSettings({ ...(await getSettings()), collectionEnabled: true });
  await assert.rejects(
    () =>
      collectSource(source.id, async () => {
        throw new Error('本地假服务错误');
      }),
    /假服务/,
  );
  const [saved] = await db.select().from(sources).where(eq(sources.id, source.id));
  assert.equal(saved.lastError, '本地假服务错误');
});

test('AIHOT接入保留原文、原始来源、分类和署名，304不重复导入', async () => {
  await saveSettings({ ...(await getSettings()), collectionEnabled: true });
  const [source] = await db
    .insert(sources)
    .values({
      name: 'AIHOT测试',
      url: 'https://aihot.news/api/v1/items?mode=selected',
      format: 'json',
      industryId: 'ai',
      enabled: true,
    })
    .returning();
  const body = JSON.stringify({
    schemaVersion: 1,
    items: [
      {
        id: 'upstream-id',
        title: '上游选读',
        summary: null,
        source: { name: '原始机构' },
        links: {
          original: 'https://example.invalid/original',
          aihot: 'https://aihot.news/items/upstream-id',
        },
        publishedAt: '2026-10-22T03:00:00.000Z',
        category: 'ai-models',
        attribution: { name: 'AIHOT', url: 'https://aihot.news/items/upstream-id' },
      },
    ],
  });
  const now = new Date('2026-10-23T00:00:00Z');
  await collectSource(
    source.id,
    async (url, options) => {
      assert.equal(url, source.url, '只请求汇集接口，不请求境外原页');
      options?.onHeaders?.({ etag: '"v1"' });
      return body;
    },
    now,
  );
  const [article] = await db.select().from(articles).where(eq(articles.sourceId, source.id));
  assert.equal(article.sourceName, '原始机构');
  assert.equal(article.excerpt, '上游选读');
  assert.equal(article.url, 'https://example.invalid/original');
  assert.equal(article.provenance?.category, 'AI 模型');
  assert.equal(article.provenance?.attribution.name, 'AIHOT');
  assert.deepEqual(
    await collectSource(
      source.id,
      async (_url, options) => {
        assert.equal(options?.etag, '"v1"');
        return null;
      },
      now,
    ),
    { fetched: 0, inserted: 0, unchanged: true },
  );
  assert.equal(
    (await db.select().from(articles).where(eq(articles.sourceId, source.id))).length,
    1,
  );
});
test('遵守上游Retry-After，失败不会一分钟内反复采集', async () => {
  const { SourceHttpError } = await import('../src/server/fetch.ts');
  await saveSettings({ ...(await getSettings()), collectionEnabled: true });
  const [source] = await db
    .insert(sources)
    .values({
      name: '限流源',
      url: 'https://example.invalid/rate-limit',
      format: 'json',
      industryId: 'ai',
      enabled: true,
    })
    .returning();
  const retryAt = new Date(Date.now() + 2 * 3600_000);
  await assert.rejects(
    () =>
      collectSource(source.id, async () => {
        throw new SourceHttpError(429, retryAt);
      }),
    /429/,
  );
  const [saved] = await db.select().from(sources).where(eq(sources.id, source.id));
  assert.ok(saved.nextFetchAt!.getTime() >= retryAt.getTime());
});
test('RSS只导入近期条目，缺少摘要时读取页面公开简介', async () => {
  const [source] = await db
    .insert(sources)
    .values({
      name: '官方博客',
      url: 'https://example.invalid/archive',
      format: 'rss',
      industryId: 'ai',
      enabled: true,
    })
    .returning();
  const rss =
    '<rss version="2.0"><channel><title>test</title><link>https://example.invalid</link><description>test</description><item><title>新文章</title><link>https://example.invalid/new</link><pubDate>Thu, 22 Oct 2026 07:30:00 +0800</pubDate></item><item><title>旧文章</title><link>https://example.invalid/old</link><pubDate>Wed, 22 Oct 2025 07:30:00 +0800</pubDate></item></channel></rss>';
  const result = await collectSource(
    source.id,
    async (url) =>
      url === source.url ? rss : '<meta content="官方提供的简介" property="og:description">',
    new Date('2026-10-23T00:00:00Z'),
  );
  assert.equal(result.inserted, 1);
  const [article] = await db.select().from(articles).where(eq(articles.sourceId, source.id));
  assert.equal(article.excerpt, '官方提供的简介');
});

test('原页简介读取失败不阻断订阅，不编造摘要', async () => {
  const [source] = await db
    .insert(sources)
    .values({
      name: '简介不可读',
      url: 'https://example.invalid/meta-failure-feed',
      format: 'rss',
      industryId: 'ai',
      enabled: true,
    })
    .returning();
  const rss =
    '<rss version="2.0"><channel><title>test</title><link>https://example.invalid</link><description>test</description><item><title>只有标题</title><link>https://example.invalid/meta-failure</link><pubDate>Thu, 22 Oct 2026 07:30:00 +0800</pubDate></item></channel></rss>';
  const result = await collectSource(
    source.id,
    async (url) => {
      if (url === source.url) return rss;
      throw new Error('本地TLS失败样本');
    },
    new Date('2026-10-23T00:00:00Z'),
  );
  assert.equal(result.inserted, 1);
  const [article] = await db.select().from(articles).where(eq(articles.sourceId, source.id));
  assert.equal(article.excerpt, '只有标题');
});

test('新智元官方列表读取标题、摘要和日期，保留日期精度且不访问境外页面', async () => {
  await saveSettings({ ...(await getSettings()), collectionEnabled: true });
  const [source] = await db
    .insert(sources)
    .values({
      name: '新智元测试',
      url: 'https://www.aiera.com.cn/asi-articles.html',
      format: 'html',
      industryId: 'ai',
      enabled: true,
    })
    .returning();
  const html =
    '<a class="art" href="asi-post.html?id=123"><span class="cat">AI</span><h3>真实结构样本</h3><p>站点提供的文章简介</p><div class="m"><span>2026.10.22</span></div></a><a class="art" href="asi-post.html?id=124"><h3>缺少日期</h3><p>简介</p></a>';
  const result = await collectSource(
    source.id,
    async (url) => {
      assert.equal(url, source.url);
      return html;
    },
    new Date('2026-10-23T00:00:00Z'),
  );
  assert.equal(result.inserted, 1);
  const [article] = await db.select().from(articles).where(eq(articles.sourceId, source.id));
  assert.equal(article.url, 'https://www.aiera.com.cn/asi-post.html?id=123');
  assert.equal(article.publishedPrecision, 'day');
  assert.equal(article.publishedAt.toISOString(), '2026-10-21T16:00:00.000Z');
  assert.equal(article.excerpt, '站点提供的文章简介');
});

test('机器之心免费RSS限制一小时一次，手动触发也不重复请求', async () => {
  const [source] = await db
    .insert(sources)
    .values({
      name: '机器之心限频测试',
      url: 'https://mcp.applications.jiqizhixin.com/rss',
      format: 'rss',
      intervalMinutes: 60,
      industryId: 'ai',
      enabled: true,
    })
    .returning();
  await saveSettings({ ...(await getSettings()), collectionEnabled: true });
  let requests = 0;
  const rss = async () => {
    requests++;
    return `<rss version="2.0"><channel><title>local</title><link>https://example.invalid</link><description>test</description><item><title>研究报道</title><link>https://example.invalid/jiqi-rate</link><description></description><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
  };
  await collectSource(source.id, rss);
  const [article] = await db.select().from(articles).where(eq(articles.sourceId, source.id));
  assert.equal(article.excerpt, '研究报道');
  const before = await pool.query(
    'SELECT next_fetch_at, (SELECT count(*)::int FROM collection_runs WHERE source_id=$1) runs FROM sources WHERE id=$1',
    [source.id],
  );
  const deferred = await collectSource(source.id, rss);
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.inserted, 0);
  const after = await pool.query(
    'SELECT next_fetch_at, (SELECT count(*)::int FROM collection_runs WHERE source_id=$1) runs FROM sources WHERE id=$1',
    [source.id],
  );
  // 冷却期内跳过不新增采集记录，也不产生失败任务；下次采集时间被推到冷却结束。
  assert.equal(after.rows[0].runs, before.rows[0].runs);
  assert.ok(after.rows[0].next_fetch_at.getTime() > Date.now() + 50 * 60_000);
  await assert.rejects(() => collectSource(source.id, rss, undefined, { manual: true }), /60分钟/);
  assert.equal(requests, 1);
});

test('五家金融源保留来源、日期精度并跳过已收录详情', async () => {
  const { financeSources } = await import('../src/server/finance-sources.ts');
  const now = new Date('2026-10-23T04:00:00Z');
  const next = (data: unknown) =>
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { data } } })}</script>`;
  const feeds = [
    '<rss version="2.0"><channel><title>央行</title><link>https://www.pbc.gov.cn</link><description>test</description><item><title>被截断的...</title><link>www.pbc.gov.cn/test-finance</link><description>金融政策摘要</description><pubDate>Wed, 21 Oct 2026 16:00:00 GMT</pubDate></item></channel></rss>',
    JSON.stringify({
      rptCode: 200,
      data: [
        {
          itemId: 4110,
          docInfoVOList: [
            { docId: 100, docTitle: '不采集任职批复', publishDate: '2026-10-22 10:00:00' },
          ],
        },
        {
          itemId: 915,
          docInfoVOList: [{ docId: 101, docTitle: '监管进展', publishDate: '2026-10-22 10:00:00' }],
        },
      ],
    }),
    JSON.stringify({
      data: {
        results: [
          {
            title: '制度公告',
            url: '//www.csrc.gov.cn/test-finance',
            publishedTimeStr: '2026-10-22 16:30:00',
            publishedTime: 0,
            content: '<p>制度变更的事实依据</p>',
          },
        ],
      },
    }),
    next({
      pageInfo: {
        list: [
          {
            childList: [
              { contId: '100', forwardType: 4 },
              { contId: '101', forwardType: 9 },
            ],
          },
        ],
      },
    }),
    JSON.stringify({
      status: 0,
      data: {
        list: [
          {
            newsList: [
              {
                news_id: 102,
                news_title: '机构业务',
                kind: 0,
                happen_time: Date.parse('2026-10-22T03:00:00Z'),
              },
              {
                news_id: 103,
                news_title: '视频',
                kind: 3,
                happen_time: Date.parse('2026-10-22T03:00:00Z'),
              },
            ],
          },
        ],
      },
    }),
  ];
  for (const [index, config] of financeSources.entries()) {
    const [source] = await db
      .insert(sources)
      .values({ ...config, industryId: 'finance', enabled: true })
      .returning();
    let details = 0;
    const fetcher = async (
      url: string,
      options?: import('../src/server/fetch.ts').SourceFetchOptions,
    ) => {
      if (url === source.url) return feeds[index];
      details++;
      if (index === 0) return '<title>完整的金融政策标题</title>';
      if (index === 1)
        return JSON.stringify({
          rptCode: 200,
          data: { docClob: '<style>无关样式</style><p>监管事实摘要</p>' },
        });
      if (index === 3) {
        assert.equal(url, 'https://api.cnstock.com/wap/news/newsDetails');
        assert.equal(options?.method, 'POST');
        assert.equal(JSON.parse(options?.body ?? '{}').contId, '100');
        return JSON.stringify({
          code: 200,
          data: {
            title: '银行业务进展',
            pubTime: '2026-10-22 10:00',
            source: '原始报刊',
            textInfo: { content: '<p>业务事实摘要</p>' },
          },
        });
      }
      assert.equal(options?.method, 'POST');
      assert.equal(
        new URLSearchParams(options?.body).get('data'),
        JSON.stringify({ news_id: '102' }),
      );
      return JSON.stringify({
        status: 0,
        data: { content: '<p>保险机构业务事实</p>', source: '银行保险报原始来源' },
      });
    };
    await saveSettings({ ...(await getSettings()), collectionEnabled: true });
    assert.equal((await collectSource(source.id, fetcher, now)).inserted, 1, source.name);
    const [article] = await db.select().from(articles).where(eq(articles.sourceId, source.id));
    assert.ok(article.excerpt.length > 0);
    assert.ok(!article.excerpt.includes('无关样式'));
    if (index === 0) {
      assert.equal(article.title, '完整的金融政策标题');
      assert.equal(article.url, 'https://www.pbc.gov.cn/test-finance');
      assert.equal(article.publishedPrecision, 'day');
    }
    if (index === 2) {
      assert.equal(article.publishedPrecision, 'day');
      assert.equal(article.publishedAt.toISOString(), '2026-10-21T16:00:00.000Z');
    }
    if (index === 3) assert.equal(article.sourceName, '原始报刊');
    const previous = details;
    assert.equal((await collectSource(source.id, fetcher, now)).inserted, 0);
    assert.equal(details, previous, '已导入原文不重复请求详情');
  }
});

test('调频读取信源自身新增量，跨信源去重及304不误判更新节奏', async () => {
  await saveSettings({ ...(await getSettings()), collectionEnabled: true });
  const [source] = await db
    .insert(sources)
    .values({
      name: '节奏测试',
      url: 'https://example.invalid/rhythm',
      format: 'json',
      industryId: 'ai',
      enabled: true,
      autoInterval: true,
      intervalMinutes: 30,
      minIntervalMinutes: 10,
      maxIntervalMinutes: 120,
      stableRuns: 3,
    })
    .returning();
  const now = new Date('2026-10-23T00:00:00Z');
  const item = {
    title: '已有资讯',
    url: 'https://example.invalid/cross-source-rhythm',
    excerpt: '已有摘要',
    publishedAt: '2026-10-22T00:00:00Z',
  };
  const { importArticle } = await import('../src/server/collect.ts');
  await importArticle({ ...item, sourceName: '其他信源', industryId: 'ai' });
  const fetcher = async () => JSON.stringify([item]);
  assert.equal((await collectSource(source.id, fetcher, now)).inserted, 0);
  assert.equal(
    (await db.select().from(sources).where(eq(sources.id, source.id)))[0].intervalMinutes,
    24,
  );
  await collectSource(source.id, async () => null, now);
  await collectSource(source.id, fetcher, now);
  const last = await pool.query(
    'SELECT result FROM collection_runs WHERE source_id=$1 ORDER BY finished_at DESC LIMIT 1',
    [source.id],
  );
  assert.equal(last.rows[0].result.sourceNew, 0);
  const saved = (await db.select().from(sources).where(eq(sources.id, source.id)))[0];
  assert.equal(saved.intervalMinutes, 24);
  assert.equal(saved.quietRuns, 2);
});
