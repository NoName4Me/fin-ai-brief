import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, db } from '../src/server/db.ts';
import { sources, articles } from '../src/server/schema.ts';
import { migrate } from '../scripts/migrate.ts';
import { collectSource } from '../src/server/collect.ts';
import { sourceQualityData } from '../src/server/source-metrics.ts';
import { officialListItems, readSourceDetail } from '../src/server/source-details.ts';
import { sourceRequestUrl } from '../src/server/source-access.ts';
import { saveSettings } from '../src/server/settings.ts';
import { defaultSettings } from '../src/server/types.ts';
if (!/_test$/.test(new URL(process.env.DATABASE_URL!).pathname)) throw Error('必须使用_test数据库');
before(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE sources,articles,events,collection_runs CASCADE');
  await saveSettings({ ...defaultSettings, collectionEnabled: false });
});
after(() => pool.end());
const first = 'https://www.pbc.gov.cn/tiaofasi/144941/3581332/index.html';
const second = 'https://www.pbc.gov.cn/tiaofasi/144941/144957/index.html';
const link = '/tiaofasi/144941/3581332/2026102612345678901/index.html';
const listing = (date: string, url = link) =>
  `<table><tr><td><a href="${url}" title="完整政策标题">缩略标题…</a><span>${date}</span></td></tr></table>`;
test('官方列表按同一条目的日期取时间，保留完整标题并支持无引号链接', () => {
  const list = officialListItems(
    listing('2026-10-26') + listing('2026-09-01', link.replace('01/', '02/')),
    first,
  )!;
  assert.equal(list[0].title, '完整政策标题');
  assert.match(list[1].publishedAt, /2026-09-01/);
  const cac = officialListItems(
    '<li><h5><a href=//www.cac.gov.cn/2026-10/26/c_12345.htm>政策文件标题</a></h5><div>2026-10-26</div></li>',
    'https://www.cac.gov.cn/wxzw/wxfb/A093702index_1.htm',
  )!;
  assert.equal(cac.length, 1);
  assert.match(
    sourceRequestUrl('https://www.nfra.gov.cn/cn/view/pages/ItemList.html?itemId=928'),
    /itemId=928&pageSize=18/,
  );
});
test('多入口共享去重，只有窗口内未收录条目才抓详情，关闭时保留列表材料', async () => {
  const [source] = await db
    .insert(sources)
    .values({
      name: '央行',
      url: first,
      additionalUrls: [second],
      readDetails: true,
      format: 'html',
      industryId: 'ai',
      enabled: true,
    })
    .returning();
  const called: string[] = [];
  const fetcher = async (url: string) => {
    called.push(url);
    return [first, second].includes(url)
      ? listing('2026-10-26') + listing('2026-09-01', link.replace('01/', '02/'))
      : '<h1>完整文件标题</h1><div id="zoom">这是政策正文，明确了适用主体、生效日期和执行要求，包含完整的文件内容。</div>';
  };
  await collectSource(source.id, fetcher, new Date('2026-10-29T00:00:00Z'), { manual: true });
  assert.equal(called.filter((u) => u === new URL(link, first).href).length, 1);
  assert.equal((await db.select().from(articles)).length, 1);
  assert.match((await db.select().from(articles))[0].excerpt, /适用主体/);
  await collectSource(source.id, fetcher, new Date('2026-10-29T00:00:00Z'), { manual: true });
  assert.equal(called.filter((u) => u === new URL(link, first).href).length, 1);
  await pool.query('DELETE FROM articles');
  await pool.query('UPDATE sources SET read_details=false WHERE id=$1', [source.id]);
  called.length = 0;
  await collectSource(source.id, fetcher, new Date('2026-10-29T00:00:00Z'), { manual: true });
  assert.equal(called.length, 2);
  assert.equal((await db.select().from(articles))[0].excerpt, '完整政策标题');
});
test('详情正文缺失会记录失败并继续其它入口，拒绝用标题代替正文', async () => {
  const [source] = await db
    .insert(sources)
    .values({
      name: '央行',
      url: first,
      additionalUrls: [second],
      readDetails: true,
      format: 'html',
      industryId: 'ai',
      enabled: true,
    })
    .returning();
  const called: string[] = [];
  await assert.rejects(
    collectSource(
      source.id,
      async (url) => {
        called.push(url);
        return [first, second].includes(url)
          ? listing('2026-10-26')
          : '<nav>菜单</nav><h1>只有标题</h1>';
      },
      new Date('2026-10-29T00:00:00Z'),
      { manual: true },
    ),
    /正文区域/,
  );
  assert.ok(called.includes(second));
  assert.equal((await db.select().from(articles)).length, 0);
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM collection_items WHERE outcome='failed'"))
      .rows[0].n,
    2,
  );
});
test('金融监管总局按页面栏目解析列表及正文接口，忽略导航和脚本', async () => {
  const url = 'https://www.nfra.gov.cn/cn/view/pages/ItemList.html?itemId=928';
  const list = officialListItems(
    JSON.stringify({
      rptCode: 200,
      data: { rows: [{ docId: 1234, docTitle: '规范文件', publishDate: '2026-10-26 10:00:00' }] },
    }),
    url,
  )!;
  assert.match(list[0].url, /itemId=928/);
  const detail = await readSourceDetail(list[0].url, async (input) => {
    assert.match(input, /SelectByDocId\?docId=1234/);
    return JSON.stringify({
      rptCode: 200,
      data: {
        docClob:
          '<p>这是监管总局规范性文件的完整正文，明确金融机构适用条件和执行要求。</p><script>恶意文本</script>',
      },
    });
  });
  assert.match(detail.excerpt, /适用条件/);
  assert.doesNotMatch(detail.excerpt, /恶意文本/);
});

test('仅含PDF的详情页读取附件正文，并拒绝跨站附件', async () => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream =
    'BT /F1 12 Tf 40 700 Td (This policy document defines scope and implementation requirements.) Tj ET';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const url = 'https://www.cac.gov.cn/2026-10/26/c_12345.htm';
  const result = await readSourceDetail(url, async (input, options) => {
    if (input.endsWith('.pdf')) {
      assert.equal(options?.binaryBase64, true);
      return Buffer.from(pdf).toString('base64');
    }
    return '<div id="BodyLabel"><a href="/file.pdf">下载文件</a></div>';
  });
  assert.match(result.excerpt, /implementation requirements/);
  await assert.rejects(
    readSourceDetail(
      url,
      async () => '<div id="BodyLabel"><a href="https://other.example/file.pdf">文件</a></div>',
    ),
    /同一官网/,
  );
});

test('发改委文件库使用配置页对应的官方接口，并读取文件正文', async () => {
  const url = 'https://www.ndrc.gov.cn/xxgk/wjk/index.html?tab=all';
  const request = new URL(sourceRequestUrl(url));
  assert.equal(request.origin, 'https://fwfx.ndrc.gov.cn');
  assert.equal(request.searchParams.get('tab'), 'all');
  assert.equal(request.searchParams.get('sort'), 'dateDesc');
  const {
    title,
    excerpt,
    url: detail,
    publishedAt,
  } = officialListItems(
    JSON.stringify({
      code: 200,
      data: {
        resultList: [
          {
            title: '关于<em>人工智能</em>发展的通知',
            url: 'https://www.ndrc.gov.cn/xxgk/zcfb/tz/202610/t20261028_1408423.html',
            docDate: '2026-10-28',
          },
        ],
      },
    }),
    url,
  )![0];
  assert.equal(title, '关于人工智能发展的通知');
  assert.equal(excerpt, title);
  assert.equal(publishedAt, '2026-10-28T00:00:00+08:00');
  const content = await readSourceDetail(
    detail,
    async () =>
      '<h2 class="article_title">完整文件标题</h2><div class="TRS_Editor">这是通知文件的完整正文，明确相关主体的实施要求和文件适用范围。</div><footer>网站导航及版权</footer>',
  );
  assert.equal(content.title, '完整文件标题');
  assert.match(content.excerpt, /实施要求/);
  assert.doesNotMatch(content.excerpt, /网站导航/);
  assert.throws(() => officialListItems(JSON.stringify({ code: 500 }), url), /列表格式/);
});

test('财政部列表识别官方司局子站，按条目日期过滤并读取详情正文', async () => {
  const url = 'https://www.mof.gov.cn/zhengwuxinxi/zhengcefabu/';
  const html =
    '<ul><li><a href="http://jkw.mof.gov.cn/zhengcefabu/202610/t20261014_4002838.htm" title="政策完整标题">政策…</a><span>2026-10-15</span></li><li><a href="https://mof.gov.cn.evil.invalid/file.htm">伪造站点</a><span>2026-10-28</span></li></ul>';
  const items = officialListItems(html, url)!;
  assert.equal(items.length, 1);
  assert.match(items[0].url, /^https:\/\/jkw.mof.gov.cn\//);
  assert.equal(items[0].title, '政策完整标题');
  assert.equal(items[0].publishedAt, '2026-10-15T00:00:00+08:00');
  const detail = await readSourceDetail(
    items[0].url,
    async () =>
      '<meta name="ArticleTitle" content="财政政策完整标题"><div class="TRS_Editor"><p>这是财政部发布文件的完整正文，明确资金管理方式、适用范围和相关要求。</p></div><footer>网站导航</footer>',
  );
  assert.equal(detail.title, '财政政策完整标题');
  assert.match(detail.excerpt, /资金管理方式/);
  assert.doesNotMatch(detail.excerpt, /网站导航/);
});

test('金融时报网页按同一新闻卡片取标题日期，去重并排除站外链接', async () => {
  const url = 'https://www.financialnews.com.cn/node_3012.html';
  const card = (date: string, href: string, title: string) =>
    `<dl><dt><a href="${href}"><img src="a.jpg"></a></dt><dd><h4><a href="${href}">${title}</a></h4><p>这是列表真实提供的摘要。</p><h6><span>${date}</span><span>来源：金融时报</span></h6></dd></dl>`;
  const path = 'http://www.financialnews.com.cn/2026-10/14/content_458716.html';
  const html =
    '<div class="news-list">' +
    card('2026-10-14', path, '金融AI智能体进展') +
    card('2026-09-30', path.replace('458716', '458137'), '另一项新闻') +
    card('2026-10-14', path, '重复链接') +
    card('2026-10-28', 'https://other.invalid/content_1.html', '站外新闻') +
    '</div>';
  const items = officialListItems(html, url)!;
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '金融AI智能体进展');
  assert.match(items[0].url, /^https:/);
  assert.equal(items[1].publishedAt, '2026-09-30T00:00:00+08:00');
  assert.equal(items[0].excerpt, '这是列表真实提供的摘要。');
  assert.equal(sourceRequestUrl(url), url);
  const detail = await readSourceDetail(
    items[0].url,
    async () =>
      '<div class="detail-title"><h3>完整新闻标题</h3></div><div class="detail-cont"><p>金融机构发布智能体平台，说明部署条件、安全要求和实际应用场景。</p></div><div class="banquan">版权和转载说明</div><nav>网站导航</nav>',
  );
  assert.equal(detail.title, '完整新闻标题');
  assert.match(detail.excerpt, /部署条件/);
  assert.doesNotMatch(detail.excerpt, /版权|网站导航/);
});

test('银行保险报栏目只请求配置频道，合并置顶与普通新闻去重，读取网页正文', async () => {
  const url = 'https://www.cbimc.cn/channel/4/3261';
  const endpoint = new URL(sourceRequestUrl(url));
  assert.equal(endpoint.origin, 'https://rm-api.cfmc.cn');
  const data = JSON.parse(endpoint.searchParams.get('data')!);
  assert.equal(data.channel_id, 3261);
  assert.equal(data.channel_type, 4);
  const { sourceRequestOptions } = await import('../src/server/source-access.ts');
  assert.equal(sourceRequestOptions(url).method, 'POST');
  assert.equal(sourceRequestOptions(url).headers?.tenantId, '37');
  const row = {
    news_id: 335077,
    news_title: '金融科技大会',
    happen_time: Date.parse('2026-10-26T02:38:04Z'),
    flag: 0,
  };
  const items = officialListItems(
    JSON.stringify({
      status: 0,
      data: { bannerNewsList: [row], newsList: [row, { ...row, news_id: 335078, flag: 4 }] },
    }),
    url,
  )!;
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://www.cbimc.cn/news/335077');
  const detail = await readSourceDetail(
    items[0].url,
    async () =>
      '<meta property="og:title" content="金融科技大会完整标题"><div class="content___outer">网站导航</div><div class="pageCenter___abc"><div class="content___xyz"><p>这是银行保险报的完整新闻正文，介绍大会内容、适用条件和金融科技发展。</p></div></div><footer>网站版权</footer>',
  );
  assert.equal(detail.title, '金融科技大会完整标题');
  assert.match(detail.excerpt, /大会内容/);
  assert.doesNotMatch(detail.excerpt, /网站导航|网站版权/);
});

test('21世纪经济报道从新闻列表取移动版文章，以原文URL明确日期筛选并读取正文', async () => {
  const url = 'https://www.21jingji.com/channel/finance';
  const article = 'https://m.21jingji.com/article/20261029/herald/1234.html';
  const items = officialListItems(
    `<div class="col-l"><div class="news"><a href="${article}" title="完整财经标题"><h2>新闻</h2><p>简介</p><span>1小时前</span></a></div></div><div class="hot-list"><a href="https://m.21jingji.com/article/20261020/herald/9999.html">热文</a></div>`,
    url,
  )!;
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '完整财经标题');
  assert.equal(items[0].publishedAt, '2026-10-29T00:00:00+08:00');
  const detail = await readSourceDetail(
    article,
    async () =>
      '<h1>完整财经标题</h1><div class="txtContent"><div class="main_content"><p>这是二十一世纪经济报道新闻的真实正文，包含金融市场变化和明确使用条件。</p></div><p class="copyright">网站版权说明</p></div><nav>导航</nav>',
  );
  assert.match(detail.excerpt, /金融市场变化/);
  assert.doesNotMatch(detail.excerpt, /版权说明|导航/);
});

test('证券时报两个栏目独立解析时间，重复链接只保留一次，正文不带版权与侧栏', async () => {
  const now = new Date('2026-10-29T06:00:00Z');
  const card = (id: number, time: string, summary = '材料讨论2020-01-01的政策。') =>
    `<li><div class="content"><div class="tt"><a href="/article/detail/${id}.html">证券时报新闻${id}</a></div><div class="text">${summary}</div><div class="info"><span>来源</span><span>${time}</span></div></div></li>`;
  for (const url of [
    'https://www.stcn.com/article/list/yw.html',
    'https://www.stcn.com/article/list/finance.html',
  ]) {
    const rows = officialListItems(
      '<ul class="infinite-list">' +
        card(123, '12:58') +
        card(124, '10-28 18:05') +
        card(123, '12:58') +
        card(125, '无日期') +
        '</ul>',
      url,
      now,
    )!;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].publishedAt, '2026-10-29T12:58:00+08:00');
    assert.equal(rows[1].publishedAt, '2026-10-28T18:05:00+08:00');
    assert.equal(sourceRequestUrl(url), url);
  }
  const rollover = officialListItems(
    '<ul class="infinite-list">' + card(1, '12-31 22:30') + '</ul>',
    'https://www.stcn.com/article/list/yw.html',
    new Date('2027-01-01T04:00:00Z'),
  )!;
  assert.equal(rollover[0].publishedAt, '2026-12-31T22:30:00+08:00');
  const detail = await readSourceDetail(
    'https://www.stcn.com/article/detail/123.html',
    async () =>
      '<h1>证券时报完整标题</h1><div class="detail-content"><p>证券时报这篇报道明确了金融科技进展、实施主体、适用条件和事实依据。</p><script>推广脚本</script></div><div class="detail-content-statement">版权声明</div><aside>热文排行</aside>',
  );
  assert.match(detail.excerpt, /事实依据/);
  assert.doesNotMatch(detail.excerpt, /版权|热文|推广脚本/);
});
test('纯图片资讯记为无有效文本，不阻断同批可读正文', async () => {
  const [source] = await db
    .insert(sources)
    .values({
      name: '政策网页',
      url: first,
      format: 'html',
      industryId: 'ai',
      enabled: true,
      readDetails: true,
    })
    .returning();
  const image = link.replace('01/', '99/');
  const result = await collectSource(
    source.id,
    async (url) =>
      url === first
        ? listing('2026-10-28', image) + listing('2026-10-28')
        : url === new URL(image, first).href
          ? '<div id="zoom"><img src="/poster.jpg"></div>'
          : '<div id="zoom">这是一篇含有完整信息的政策正文，说明了政策内容、适用范围和执行要求。</div>',
    new Date('2026-10-29T08:00:00Z'),
    { manual: true },
  );
  assert.equal(result.inserted, 1);
  const outcomes = (await pool.query('SELECT outcome FROM collection_items ORDER BY id')).rows.map(
    (r) => r.outcome,
  );
  assert.deepEqual(outcomes, ['invalid', 'new']);
  const quality = await sourceQualityData(7, undefined, new Date('2026-10-29T08:00:00Z'));
  assert.equal(
    quality.discoveries.find((v) => v.url === new URL(image, first).href)?.state,
    'invalid',
  );
});
test('TLDR 完整摘要直接入库，启用详情时也不额外请求原文', async () => {
  const url = 'https://tldr.tech/ai/archives';
  const [source] = await db
    .insert(sources)
    .values({
      name: 'TLDR AI',
      url,
      format: 'html',
      industryId: 'ai',
      enabled: true,
      readDetails: true,
    })
    .returning();
  const calls: string[] = [];
  const result = await collectSource(
    source.id,
    async (endpoint) => {
      calls.push(endpoint);
      if (endpoint === url) return '<a href="/ai/2026-10-28">期刊</a>';
      if (endpoint === 'https://tldr.tech/ai/2026-10-28')
        return '<article><a href="https://example.com/news"><h3>模型更新发布</h3></a><div class="newsletter-html">完整摘要包含新模型能力、发布方式和适用场景，作为后续分析材料。</div></article>';
      throw Error('不应抓原文');
    },
    new Date('2026-10-29T08:00:00Z'),
    { manual: true },
  );
  assert.equal(result.inserted, 1);
  assert.equal(calls.length, 2);
  const [article] = await db.select().from(articles);
  assert.match(article.excerpt, /新模型能力/);
});
