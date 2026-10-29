import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/server/db.ts';
import { migrate } from '../scripts/migrate.ts';
import { collectSource } from '../src/server/collect.ts';
import { verifySource } from '../src/server/source-verification.ts';
import { processArticle } from '../src/server/process.ts';
import { saveSettings } from '../src/server/settings.ts';
import { defaultSettings } from '../src/server/types.ts';
import {
  githubRanking,
  openCompassRanking,
  rankingItem,
  rankingSnapshotUrl,
} from '../src/server/ranking-sources.ts';
import { sourceQualityData } from '../src/server/source-metrics.ts';
if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw Error('须使用独立_test库');
before(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE sources,articles,events,collection_runs CASCADE');
  await saveSettings({ ...defaultSettings, collectionEnabled: false });
});
after(() => pool.end());
const url = 'https://github.com/trending';
const now = new Date('2026-10-29T08:00:00Z');
const listing = (names = ['alpha', 'beta']) =>
  names
    .map(
      (name) =>
        `<article class="Box-row"><h2><a href="/org/${name}">org / ${name}</a></h2><p>AI tools and models</p><span class="float-sm-right">100 stars today</span></article>`,
    )
    .join('');
const entries = githubRanking(listing(), url);
test('榜单解析不填发布时间，首次快照仅建立基线', () => {
  const item = rankingItem('GitHub Trending', {
    boardUrl: url,
    observedAt: now.toISOString(),
    entries,
  });
  assert.equal(item.publishedPrecision, 'observed');
  assert.equal(item.provenance?.snapshot?.observedAt, now.toISOString());
  assert.match(item.excerpt, /首份快照，仅建立基线/);
  assert.doesNotMatch(item.excerpt, /本次上榜/);
  assert.equal(entries[0].name, 'org/alpha');
  assert.equal(entries[0].metric, '100 stars today');
  assert.throws(() => githubRanking('<nav>没有榜单</nav>', url), /未解析到/);
  assert.throws(
    () => githubRanking(listing() + '<article class="Box-row"><h2>数据缺失</h2></article>', url),
    /条目不完整/,
  );
  assert.throws(() => githubRanking(listing(['alpha', 'alpha']), url), /条目异常/);
});
test('比较上一份快照，区分排名升降、本次上榜和离开榜单范围', () => {
  const previous = {
    boardUrl: url,
    observedAt: new Date('2026-10-28T08:00:00Z').toISOString(),
    entries,
  };
  const item = rankingItem(
    'GitHub Trending',
    {
      boardUrl: url,
      observedAt: now.toISOString(),
      entries: githubRanking(listing(['beta', 'gamma']), url),
    },
    previous,
  );
  assert.match(item.excerpt, /org\/beta：第2位→第1位（上升1位）/);
  assert.match(item.excerpt, /org\/gamma：本次上榜/);
  assert.match(item.excerpt, /org\/alpha：离开当前榜单范围/);
  assert.equal(item.provenance?.snapshot?.previousObservedAt, previous.observedAt);
});
test('OpenCompass 读取配置的官方维度并按得分排序，不把评测日期当采集日期', () => {
  const data = {
    modelBase: {
      a: { model: 'Model A', model_link: 'https://example.com/a', date: '2026/09/01' },
      b: { model: 'Model B' },
    },
    OverallTable: [
      { key: 'a', Average: 72 },
      { key: 'b', Average: 80 },
    ],
    KnowledgeTable: [
      { key: 'a', Average: 91 },
      { key: 'b', Average: 70 },
    ],
  };
  const base = 'https://rank.opencompass.org.cn/leaderboard/llm#ability?class=official&tab=';
  const overall = openCompassRanking(JSON.stringify(data), base + 'Overall');
  assert.equal(overall.entries[0].name, 'Model B');
  assert.equal(overall.entries[1].score, 72);
  const knowledge = openCompassRanking(JSON.stringify(data), base + 'Knowledge');
  assert.equal(knowledge.entries[0].name, 'Model A');
  assert.match(knowledge.entries[0].description!, /官方评测时间：2026\/09\/01/);
  assert.throws(
    () => openCompassRanking(JSON.stringify({ ...data, modelBase: {} }), base + 'Overall'),
    /缺少模型资料/,
  );
});
test('每日边界按北京时间，榜单配置变化不混为同一快照', () => {
  assert.notEqual(
    rankingSnapshotUrl(url, new Date('2026-10-29T15:59:59Z')),
    rankingSnapshotUrl(url, new Date('2026-10-29T16:00:00Z')),
  );
  assert.notEqual(rankingSnapshotUrl(url, now), rankingSnapshotUrl(url + '?since=weekly', now));
});
async function source() {
  return (
    await pool.query(
      "INSERT INTO sources(name,url,format,industry_id,enabled,read_details,etag) VALUES('GitHub Trending',$1,'html','ai',true,true,'stale-etag') RETURNING id",
      [url],
    )
  ).rows[0].id as string;
}
test('同日重复不再请求、不覆盖首份快照；跨日保存并与前一日比较', async () => {
  const id = await source();
  let calls = 0;
  const first = await collectSource(
    id,
    async (_, options) => {
      calls++;
      assert.equal(options?.etag, null);
      return listing();
    },
    now,
    { manual: true },
  );
  assert.equal(first.inserted, 1);
  const duplicate = await collectSource(
    id,
    async () => {
      throw Error('同日不应再次请求');
    },
    new Date(now.getTime() + 3600000),
    { manual: true },
  );
  assert.equal(duplicate.inserted, 0);
  const tomorrow = new Date('2026-10-30T08:00:00Z');
  const second = await collectSource(
    id,
    async () => {
      calls++;
      return listing(['beta', 'gamma']);
    },
    tomorrow,
    { manual: true },
  );
  assert.equal(second.inserted, 1);
  assert.equal(calls, 2);
  const rows = (await pool.query('SELECT * FROM articles ORDER BY published_at')).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].published_precision, 'observed');
  assert.equal(rows[0].provenance.snapshot.observedAt, now.toISOString());
  assert.match(rows[1].excerpt, /第2位→第1位/);
  const quality = await sourceQualityData(7, undefined, tomorrow);
  assert.equal(quality.discoveries[0].published_precision, 'observed');
  assert.equal(quality.discoveries[0].snapshot?.entries.length, 2);
});
test('验证只读取榜单，失败不留假快照，重试后可正常保存', async () => {
  const id = await source();
  const result = await verifySource(id, async () => listing());
  assert.equal(result.status, 'approved');
  assert.equal((await pool.query('SELECT count(*)::int n FROM articles')).rows[0].n, 0);
  await pool.query(
    'UPDATE sources SET interval_minutes=1440,min_interval_minutes=1440,max_interval_minutes=1440 WHERE id=$1',
    [id],
  );
  await assert.rejects(
    collectSource(id, async () => '<html>加载失败</html>', now, { manual: true }),
    /未解析到/,
  );
  assert.equal((await pool.query('SELECT count(*)::int n FROM articles')).rows[0].n, 0);
  const retry = (await pool.query('SELECT next_fetch_at FROM sources WHERE id=$1', [id])).rows[0]
    .next_fetch_at;
  assert.ok(
    retry.getTime() > Date.now() + 59 * 60000 && retry.getTime() <= Date.now() + 60 * 60000,
  );
  assert.equal((await collectSource(id, async () => listing(), now, { manual: true })).inserted, 1);
});
test('后续分析收到采集时间，不能把快照时间作为资讯发布时间', async () => {
  const sourceId = await source();
  await collectSource(sourceId, async () => listing(), now, { manual: true });
  const {
    rows: [article],
  } = await pool.query('SELECT id FROM articles WHERE source_id=$1', [sourceId]);
  const originalFetch = globalThis.fetch;
  const overrides = {
    MODEL_CALLS_ENABLED: 'true',
    LLM_BASE_URL: 'http://model.invalid/v1',
    LLM_API_KEY: 'test-only',
    LLM_MODEL: 'test-model',
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((k) => [k, process.env[k]]));
  Object.assign(process.env, overrides);
  let checked = false;
  try {
    globalThis.fetch = async (_, options) => {
      const body = JSON.parse(String(options?.body));
      const data = JSON.parse(
        body.messages.find((m: { role: string }) => m.role === 'user').content,
      );
      assert.equal(data.observedAt, now.toISOString());
      assert.equal(data.article.observedAt, now.toISOString());
      assert.equal(data.article.publishedAt, undefined);
      assert.equal(data.reportedAt, undefined);
      assert.equal(data.article.publishedPrecision, 'observed');
      assert.match(body.messages[0].content, /采集时间不是模型或项目发布时间/);
      checked = true;
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  relevant: false,
                  reason: '首次榜单基线，暂无实质排名变化',
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    };
    await processArticle(article.id);
    assert.equal(checked, true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
