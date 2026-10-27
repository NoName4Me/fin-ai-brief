import { mkdir, writeFile } from 'node:fs/promises';
import { pool } from '../src/server/db.ts';
import { fetchSource } from '../src/server/fetch.ts';
import { parseRssItems } from '../src/server/collect.ts';
import { isJiqizhixinRss } from '../src/server/source-access.ts';

// Read-only checks: no article imports, model calls, source enablement or email.
const candidates = [
  ['量子位', 'https://www.qbitai.com/feed', '中文AI专业媒体'],
  ['机器之心', 'https://mcp.applications.jiqizhixin.com/rss', '中文AI专业媒体'],
  ['InfoQ中文', 'https://www.infoq.cn/feed', '工程实践补充'],
  ['未央网', 'https://www.weiyangx.com/feed', '金融科技补充，须筛AI关联'],
  ['Hugging Face Blog', 'https://huggingface.co/blog/feed.xml', '原始技术发布'],
  ['arXiv cs.AI', 'https://rss.arxiv.org/rss/cs.AI', '论文线索，非全文全量入选'],
  ['arXiv cs.CL', 'https://rss.arxiv.org/rss/cs.CL', '论文线索，可能与cs.AI交叉'],
  ['OpenAI', 'https://openai.com/news/rss.xml', '原始厂商发布'],
  ['Google DeepMind', 'https://deepmind.google/blog/rss.xml', '原始厂商发布'],
  [
    'MIT Technology Review AI',
    'https://www.technologyreview.com/topic/artificial-intelligence/feed',
    '专业报道候选',
  ],
  ['TLDR AI', 'https://tldr.tech/api/rss/ai', '聚合线索，与原始来源可能重复'],
  ['36氪', 'https://36kr.com/feed', '综合媒体，须筛AI关联'],
] as const;
const results: {
  name: string;
  url: string;
  purpose: string;
  status: string;
  count: number;
  withExcerpt?: number;
  latest?: string;
  reason?: string;
  sample?: { title: string; url: string; publishedAt: string }[];
}[] = [];
const previous = await pool.query('SELECT url,last_fetched_at FROM sources');
let index = 0;
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (index < candidates.length) {
      const [name, url, purpose] = candidates[index++];
      const last = previous.rows.find((r) => r.url === url)?.last_fetched_at;
      if (isJiqizhixinRss(url) && last && Date.now() - new Date(last).getTime() < 3600000) {
        results.push({
          name,
          url,
          purpose,
          status: '待验证',
          count: 0,
          reason: '遵守官方60分钟请求间隔，本轮未重复请求',
        });
        continue;
      }
      try {
        const text = await fetchSource(url);
        const items = await parseRssItems(text ?? '');
        results.push({
          name,
          url,
          purpose,
          status: items.length ? '可解析' : '待验证',
          count: items.length,
          withExcerpt: items.filter((i) => i.excerpt !== i.title).length,
          latest: items
            .map((i) => i.publishedAt)
            .sort()
            .at(-1),
          sample: items
            .slice(0, 5)
            .map(({ title, url, publishedAt }) => ({ title, url, publishedAt })),
        });
      } catch (error) {
        results.push({
          name,
          url,
          purpose,
          status: '待验证',
          count: 0,
          reason: error instanceof Error ? error.message : '请求失败',
        });
      }
    }
  }),
);
results.sort(
  (a, b) =>
    candidates.findIndex((c) => c[0] === a.name) - candidates.findIndex((c) => c[0] === b.name),
);
await mkdir('.data/source-check', { recursive: true });
await writeFile(
  '.data/source-check/ai-daily-rss.json',
  JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2),
);
const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
await writeFile(
  'docs/ai-daily-sources.md',
  `# AI日报信源核查\n\n核查日期：${date}。仅请求列表与RSS，不调用模型、不导入资讯、不启用新增信源。一次请求结果不代表长期稳定性。\n\n| 来源 | RSS候选地址 | 本轮结果 | 可解析条目 | 用途与处理 |\n| --- | --- | --- | ---: | --- |\n${results.map((r) => `| ${r.name} | ${r.url} | ${r.status}${r.reason ? `：${r.reason.replace(/\s+/g, ' ').replace(/</g, '&lt;').replace(/\|/g, '/')}` : ''} | ${r.count} | ${r.purpose}${r.latest ? `；最近时间${r.latest.slice(0, 10)}` : ''} |`).join('\n')}\n\n## 筛选结论\n\n- 优先复用现有量子位、机器之心、新智元官方入口，避免新增重复聚合通道。机器之心遵守令牌与60分钟间隔。\n- 新智元保留已适配官网作为RSS例外。央行、金融监管总局、证监会保留一手监管价值，但每条继续判断AI实质关联；上证报与银行保险报作为AI同业报道补充。\n- 原始技术发布用于核实能力和授权变化，不能将厂商自述当作独立效果验证。\n- arXiv两类存在交叉收录可能，只作论文线索，按事件与论文标识去重，不全量刊登。\n- TLDR及其他聚合源不与原始发布源重复铺开；已接入AIHOT维持线索用途，新增聚合候选暂不启用。\n- 36氪等综合源暂不扩充，先观察已有专业来源缺口；公众号镜像、付费终端和待核实账号不作为首批新增依赖。\n- 接口失败归为待验证，不据单次失败判定机构质量低。质量与跨源重复率由管理台近30天采入、无关淘汰、重复事件占比持续观察。\n\n原始抽样结果保存在忽略提交的\`.data/source-check/ai-daily-rss.json\`；核查不会自动启用候选；配置脚本选择其中三家原始技术发布源，实际部署网络可达性与长期产出仍需观察。\n`,
);
console.log(
  JSON.stringify(
    results.map(({ name, status, count, reason }) => ({ name, status, count, reason })),
  ),
);
await pool.end();
