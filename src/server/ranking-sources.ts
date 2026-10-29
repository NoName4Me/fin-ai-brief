import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { z } from 'zod';
import { pool } from './db.ts';
import { localDate } from './periods.ts';
import { rankingSnapshotSchema, type RankingSnapshot } from './types.ts';
import type { SourceFetchOptions } from './fetch.ts';
import type { WebItem } from './web-sources.ts';
export function rankingKind(input: string) {
  const u = new URL(input);
  if (u.hostname === 'github.com' && /^\/trending(?:\/|$)/.test(u.pathname)) return 'github';
  if (u.hostname === 'rank.opencompass.org.cn' && u.pathname === '/leaderboard/llm')
    return 'opencompass';
  return null;
}
export function rankingSnapshotUrl(input: string, now: Date) {
  const u = new URL(input);
  u.searchParams.set('brief_snapshot', localDate(now));
  u.searchParams.set('brief_board', createHash('sha256').update(input).digest('hex').slice(0, 16));
  u.hash = '';
  return u.href;
}
export function githubRanking(html: string, input: string): RankingSnapshot['entries'] {
  const $ = load(html),
    entries: RankingSnapshot['entries'] = [];
  const seen = new Set<string>();
  $('article.Box-row').each((_, el) => {
    const row = $(el),
      a = row.find('h2 a').first(),
      href = a.attr('href');
    if (!href) throw Error('GitHub Trending 榜单条目不完整，暂不保存部分快照');
    const url = new URL(href, input),
      key = url.pathname.toLowerCase();
    if (url.hostname !== 'github.com' || !/^\/[^/]+\/[^/]+$/.test(url.pathname) || seen.has(key))
      throw Error('GitHub Trending 榜单条目异常，暂不保存部分快照');
    seen.add(key);
    entries.push({
      key,
      name: a.text().replace(/\s+/g, '').trim(),
      url: url.href,
      rank: entries.length + 1,
      description: row.find('p').text().replace(/\s+/g, ' ').trim().slice(0, 1500),
      metric: row.find('.float-sm-right').text().replace(/\s+/g, ' ').trim().slice(0, 200),
    });
  });
  if (!entries.length) throw Error('GitHub Trending 未解析到项目榜单');
  return entries;
}
const tabs = {
  Overall: '综合',
  Knowledge: '知识',
  Abstraction: '抽象',
  Reasoning: '推理',
  Interaction: '交互',
  Safety: '安全',
  Agent: '智能体',
};
export function openCompassRanking(body: string, input: string) {
  const u = new URL(input),
    params = new URLSearchParams(u.hash.split('?')[1] ?? '');
  const tab = params.get('tab') || 'Overall';
  if (!Object.hasOwn(tabs, tab) || (params.get('class') && params.get('class') !== 'official'))
    throw Error('OpenCompass 暂支持官方能力榜，请检查榜单入口');
  const data = z
    .object({
      modelBase: z.record(
        z.string(),
        z.object({
          model: z.string(),
          model_link: z.string().optional(),
          org: z.string().optional(),
          date: z.string().optional(),
        }),
      ),
    })
    .passthrough()
    .parse(JSON.parse(body));
  const rows = z
    .array(z.object({ key: z.string(), Average: z.number().finite() }))
    .min(1)
    .max(1000)
    .parse(data[tab + 'Table']);
  const entries: RankingSnapshot['entries'] = rows
    .map((r) => {
      const base = data.modelBase[r.key];
      if (!base) throw Error('OpenCompass 榜单缺少模型资料，暂不保存不完整快照');
      const link = base.model_link ? new URL(base.model_link, u) : u;
      return {
        key: r.key,
        name: base.model,
        url: /^https?:$/.test(link.protocol) ? link.href : input,
        rank: 0,
        score: r.Average,
        description: [base.org, base.date ? `官方评测时间：${base.date}` : '']
          .filter(Boolean)
          .join('；'),
      };
    })
    .sort((a, b) => b.score! - a.score!);
  entries.forEach((r, i) => {
    r.rank = i + 1;
  });
  if (new Set(entries.map((r) => r.key)).size !== entries.length)
    throw Error('OpenCompass 榜单存在重复模型');
  return { name: `OpenCompass ${tabs[tab as keyof typeof tabs]}榜单`, entries };
}
export function rankingItem(
  name: string,
  snapshot: RankingSnapshot,
  previous?: RankingSnapshot,
): WebItem {
  const prior = new Map(previous?.entries.map((r) => [r.key, r]) ?? []);
  const current = new Set(snapshot.entries.map((r) => r.key));
  const changes: string[] = [];
  if (previous) {
    for (const entry of snapshot.entries) {
      const before = prior.get(entry.key);
      if (!before) changes.push(`${entry.name}：本次上榜（上次快照未列入），现第${entry.rank}位`);
      else if (before.rank !== entry.rank)
        changes.push(
          `${entry.name}：第${before.rank}位→第${entry.rank}位（${before.rank > entry.rank ? '上升' : '下降'}${Math.abs(before.rank - entry.rank)}位）`,
        );
      else if (before.score !== entry.score)
        changes.push(
          `${entry.name}：排名仍为第${entry.rank}位，得分${before.score ?? '未披露'}→${entry.score ?? '未披露'}`,
        );
    }
    for (const entry of previous.entries)
      if (!current.has(entry.key))
        changes.push(`${entry.name}：离开当前榜单范围（上次第${entry.rank}位）`);
  }
  const observed = new Date(snapshot.observedAt),
    date = localDate(observed);
  const excerpt = [
    `${name}每日快照；采集时间（北京时间）：${new Date(observed.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19)}。`,
    '采集时间不代表项目或模型的发布、上线时间。',
    previous
      ? `与${localDate(new Date(previous.observedAt))}快照比较：${changes.length ? changes.join('；') : '排名、上榜名单及得分均未变化'}。`
      : '首份快照，仅建立基线，不推断此前的新增或排名变化。',
    `榜单共${snapshot.entries.length}项，以下为前${Math.min(30, snapshot.entries.length)}项：`,
    ...snapshot.entries
      .slice(0, 30)
      .map(
        (r) =>
          `${r.rank}. ${r.name}${r.score !== undefined ? `；得分${r.score}` : ''}${r.metric ? `；${r.metric}` : ''}${r.description ? `；${r.description}` : ''}；${r.url}`,
      ),
  ]
    .join('\n')
    .slice(0, 16000);
  const url = rankingSnapshotUrl(snapshot.boardUrl, observed);
  return {
    title: `${name}快照（${date}）`,
    url,
    excerpt,
    publishedAt: snapshot.observedAt,
    publishedPrecision: 'observed',
    contentComplete: true,
    provenance: {
      itemId: url,
      category: '每日榜单快照',
      attribution: { name, url: snapshot.boardUrl },
      canonical: snapshot.boardUrl,
      snapshot: { ...snapshot, ...(previous ? { previousObservedAt: previous.observedAt } : {}) },
    },
  };
}
export async function loadRankingItems(
  html: string,
  input: string,
  fetcher: (url: string, options?: SourceFetchOptions) => Promise<string | null>,
  now = new Date(),
): Promise<WebItem[] | null> {
  const kind = rankingKind(input);
  if (!kind) return null;
  let name = 'GitHub Trending',
    entries: RankingSnapshot['entries'];
  if (kind === 'github') entries = githubRanking(html, input);
  else {
    const body = await fetcher(
      'https://cdn.opencompass.org.cn/assets/lm/data-lm-ability_official.json?benchmark=text',
    );
    if (!body) throw Error('OpenCompass 榜单数据读取失败');
    const board = openCompassRanking(body, input);
    name = board.name;
    entries = board.entries;
  }
  const snapshot = rankingSnapshotSchema.parse({
    boardUrl: input,
    observedAt: now.toISOString(),
    entries,
  });
  return [rankingItem(name, snapshot)];
}
export async function compareRankingItem(sourceId: string, item: WebItem): Promise<WebItem> {
  const snapshot = item.provenance?.snapshot;
  if (!snapshot) return item;
  const day = localDate(new Date(snapshot.observedAt));
  const { rows } = await pool.query<{ provenance: unknown }>(
    `SELECT provenance FROM articles WHERE source_id=$1
    AND provenance->'snapshot'->>'boardUrl'=$2 AND published_at<$3 ORDER BY published_at DESC LIMIT 1`,
    [sourceId, snapshot.boardUrl, new Date(day + 'T00:00:00+08:00')],
  );
  const previous = rankingSnapshotSchema.safeParse(
    (rows[0]?.provenance as { snapshot?: unknown } | undefined)?.snapshot,
  );
  return rankingItem(
    item.provenance!.attribution.name,
    snapshot,
    previous.success ? previous.data : undefined,
  );
}
