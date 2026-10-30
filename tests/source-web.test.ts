import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWebItems, parseWebItems, parseTldrIssue, webDate } from '../src/server/web-sources.ts';
import { readSourceDetail } from '../src/server/source-details.ts';
const now = new Date('2026-10-29T08:00:00Z');
test('同一条目绑定日期，拒绝无日期列表，保留原文链接', () => {
  const url = 'https://www.cinda.com.cn/home/pc/cn/xdjt/gyxd/xdxw/list_1.shtml';
  const items = parseWebItems(
    '<div class="sGray qym"><strong><a href="/home/pc/cn/xdjt/gyxd/xdxw/20261028/123.shtml">信达政策新闻</a></strong></div>',
    url,
    now,
  )!;
  assert.match(items[0].publishedAt, /2026-10-28/);
  assert.throws(
    () => parseWebItems('<a href="/news/123">没有日期的资讯</a>', url, now),
    /明确日期/,
  );
  assert.equal(webDate('2小时前', now), '2026-10-29T00:00:00+08:00');
  assert.equal(webDate('2026-02-30', now), null);
});
test('动态栏目读取官网公开数据，以条目的发布时间而非页面时间入库', async () => {
  const calls: string[] = [];
  const items = await loadWebItems(
    '<input id="catalogPath" value="financialai/">',
    'https://www.cebnet.com.cn/financialai/',
    async (url) => {
      calls.push(url);
      return JSON.stringify({
        list: [
          {
            title: '金融AI实际新闻',
            pubTime: '2026-10-28 09:10:11',
            summary: '列表摘要',
            articleLink: 'https://www.cebnet.com.cn/json/20261028/123.json',
          },
        ],
      });
    },
    now,
  );
  assert.deepEqual(calls, ['https://www.cebnet.com.cn/json/financialai/index.json']);
  assert.equal(items![0].url, 'https://www.cebnet.com.cn/20261028/123.html');
  assert.equal(items![0].publishedAt, '2026-10-28T09:10:11+08:00');
});
test('证券报日期索引只读取窗口内日期，跳过不完整记录', async () => {
  const calls: string[] = [];
  const items = await loadWebItems(
    '<script src="/xwzx/01/mi4_page_articles_guide.js"></script>',
    'https://www.cs.com.cn/xwzx/01/list.html',
    async (url) => {
      calls.push(url);
      return url.endsWith('guide.js')
        ? 'var PAGE_INDEX_MAP={"1":"mi4_sub_articles_20261029.js","2":"mi4_sub_articles_20261022.js","3":"mi4_sub_articles_20261021.js"}'
        : `var MI4_PAGE_ARTICLE=${JSON.stringify([{ foo: 1 }, { title: '中证网新闻', url: '/news/item.html', pub_date: '2026-10-28 12:10' }])};`;
    },
    now,
  );
  assert.equal(calls.length, 3);
  assert.equal(items!.length, 2);
  assert.equal(items![0].publishedAt, '2026-10-28T12:10:00+08:00');
});
test('TLDR 无需展开即可读取摘要、排除赞助，并保留期刊归属和原文链接', async () => {
  const html =
    '<article><a href="https://example.org/story"><h3>Important AI release</h3></a><div class="newsletter-html">完整摘要，包含模型能力与限制。</div></article><article><a href="https://ads.example.org"><h3>Product (Sponsor)</h3></a><div class="newsletter-html">广告</div></article>';
  const result = parseTldrIssue(html, 'https://tldr.tech/ai/2026-10-28');
  assert.equal(result.length, 1);
  assert.equal(result[0].excerpt, '完整摘要，包含模型能力与限制。');
  assert.equal(result[0].contentComplete, true);
  assert.equal(result[0].url, 'https://example.org/story');
  assert.equal(result[0].provenance?.attribution?.url, 'https://tldr.tech/ai/2026-10-28');
  const calls: string[] = [];
  const items = await loadWebItems(
    '<a href="/ai/2026-10-28">新一期</a><a href="/ai/2026-10-01">旧期刊</a><a href="/ai/2026-11-01">未来</a>',
    'https://tldr.tech/ai/archives',
    async (url) => {
      calls.push(url);
      return html;
    },
    now,
  );
  assert.deepEqual(calls, ['https://tldr.tech/ai/2026-10-28']);
  assert.equal(items!.length, 1);
});
test('招商银行公开接口已包含全文，不重复钻取；源入口仍是网页', async () => {
  const result = await loadWebItems(
    '<html/>',
    'https://www.cmbchina.com/cmbinfo/news/',
    async (url, options) => {
      assert.match(url, /\/api\/v1\/cms\/list\/paged$/);
      assert.equal(options?.method, 'POST');
      return JSON.stringify({
        returnCode: 'SUC0000',
        body: {
          pages: [
            {
              guid: 'abc',
              title: '银行新闻',
              timeEffective: '2026-10-28 12:00:00',
              contentInfo:
                '<p>这是完整文章正文，包括具体政策内容和适用范围，足够用于后续分析。</p>',
            },
          ],
        },
      });
    },
    now,
  );
  assert.equal(result![0].contentComplete, true);
  assert.match(result![0].excerpt, /具体政策内容和适用范围/);
});
test('详情选择正文区域，去除导航、标题和相关推荐；微信挑战不冒充正文', async () => {
  const result = await readSourceDetail(
    'https://www.cs.com.cn/news/a.html',
    async () =>
      '<article class="cont_article"><header><h1>文章标题</h1><nav>导航</nav></header><section>这是正式正文，包含足够长的新闻内容和完整的事实信息。</section><footer>版权</footer><aside>相关推荐</aside></article>',
  );
  assert.equal(result.title, '文章标题');
  assert.doesNotMatch(result.excerpt, /导航|版权|推荐|文章标题/);
  await assert.rejects(
    readSourceDetail(
      'https://mp.weixin.qq.com/s/test',
      async () => '<h2>环境异常</h2><p>完成验证后继续访问</p>',
    ),
    /需要验证/,
  );
});
test('CVSource 读取服务端嵌入数据，不执行脚本', () => {
  const html =
    '<script>self.__next_f.push([1,' +
    JSON.stringify(
      '1:' +
        JSON.stringify({
          id: 'report123',
          title: '研究报告',
          publishTime: 1793232000000,
          remark: '报告摘要',
        }) +
        '\n',
    ) +
    '])</script>';
  const items = parseWebItems(html, 'https://www.cvsource.com.cn/report/list', now)!;
  assert.equal(items[0].url, 'https://www.cvsource.com.cn/report/report123');
  assert.equal(items[0].excerpt, '报告摘要');
});

test('中信金融资产公司通告按公告行绑定日期并深入详情，排除新闻及导航', async () => {
  const url = 'https://www.famc.citic/hrxw/hrzs/index.shtml';
  const html = `<a href="/hrxw/hrzs/index.shtml">公司通告</a>
    <div class="jgml_list"><ul><li class="list_text5">2026/10/28</li>
      <li class="list_text6"><a href="/hrxw/hrzs/2026/96601.shtml" title="OA系统维护服务采购前公示">缩略标题…</a></li></ul>
      <ul><li class="list_text5">2026/10/26</li><li class="list_text6"><a href="/hrxw/hrzs/2026/96581.shtml" title="国产服务器采购成交结果公告">结果</a></li></ul>
      <ul><li class="list_text5"></li><li class="list_text6"><a href="/hrxw/hrzs/2026/99999.shtml">无日期公告</a></li></ul>
      <ul><li class="list_text5">2026/10/28</li><li class="list_text6"><a href="https://example.invalid/other.shtml">外站条目</a></li></ul></div>`;
  const items = parseWebItems(html, url, now)!;
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'OA系统维护服务采购前公示');
  assert.equal(items[0].publishedAt, '2026-10-28T00:00:00+08:00');
  assert.equal(items[1].publishedAt, '2026-10-26T00:00:00+08:00');
  const detail = await readSourceDetail(
    items[0].url,
    async () =>
      '<nav>导航</nav><div class="blzcwz_title2"><p><strong>OA系统维护服务采购前公示</strong></p><dd>2026-10-28</dd></div><div class="blzcwz_text"><p>项目名称：采购OA系统维护服务项目。</p><p>包括系统维护、安全补丁升级和定期巡检，供应商为泛微网络科技股份有限公司。</p></div><footer>联系方式</footer>',
  );
  assert.equal(detail.title, items[0].title);
  assert.match(detail.excerpt, /安全补丁升级/);
  assert.doesNotMatch(detail.excerpt, /导航|联系方式/);
});
