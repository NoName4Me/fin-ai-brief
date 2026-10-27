import { readFile } from 'node:fs/promises';
import { pool } from '../src/server/db.ts';

type Entry = {
  number: number;
  name: string;
  address: string;
  priority: string;
  section: string;
  notes: string | null;
  access: string;
  type: string;
};
const entries: Entry[] = JSON.parse(await readFile('src/data/source-catalog.json', 'utf8'));
const aliases: Record<string, string> = {
  'Hugging Face': 'Hugging Face Blog',
  'InfoQ 中文': 'InfoQ中文',
};
const endpoints: Record<string, string> = {
  'InfoQ 中文': 'https://www.infoq.cn/feed',
  未央网: 'https://www.weiyangx.com/feed',
  'arXiv cs.AI / cs.CL': 'https://rss.arxiv.org/rss/cs.AI',
  'MIT Technology Review': 'https://www.technologyreview.com/topic/artificial-intelligence/feed',
  'TLDR AI': 'https://tldr.tech/api/rss/ai',
};
const client = await pool.connect();
let inserted = 0,
  matched = 0;
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(76140511)');
  for (const entry of entries) {
    if (entry.section === '内部动态' || entry.name === '各银行/AMC官网采购公告') continue;
    const key = `leader-xlsx:${entry.number}`;
    if ((await client.query('SELECT 1 FROM sources WHERE catalog_key=$1', [key])).rowCount)
      continue;
    const existing = await client.query('SELECT id FROM sources WHERE name=ANY($1::text[])', [
      [entry.name, aliases[entry.name] ?? entry.name],
    ]);
    const notes = [entry.notes, `原始获取方式：${entry.access}`].filter(Boolean).join('；');
    if (existing.rowCount) {
      await client.query(
        `UPDATE sources SET catalog_key=$2,origin_address=$3,sections=$4::jsonb,priority=$5,notes=$6 WHERE id=$1`,
        [
          existing.rows[0].id,
          key,
          entry.address,
          JSON.stringify([entry.section]),
          entry.priority,
          notes,
        ],
      );
      matched++;
    } else {
      const endpoint = endpoints[entry.name] ?? null;
      await client.query(
        `INSERT INTO sources(name,url,format,origin_address,industry_id,sections,catalog_key,priority,notes,enabled,verification_note)
        VALUES($1,$2,$3,$4,'ai',$5::jsonb,$6,$7,$8,false,$9)`,
        [
          entry.name,
          endpoint,
          endpoint ? 'rss' : 'manual',
          entry.address,
          JSON.stringify([entry.section]),
          key,
          entry.priority,
          notes,
          endpoint ? '已找到RSS候选，待复核采集与内容质量' : '待寻找RSS或适配采集入口；不自动采集',
        ],
      );
      inserted++;
    }
  }
  // Existing selections retain their switches. This records their provenance, not a new network check.
  await client.query(
    `UPDATE sources SET verification_status='approved',verification_note='沿用既有选用来源；持续观察采入质量与跨源重复率' WHERE enabled AND verification_status='pending' AND verified_at IS NULL AND (catalog_key IS NOT NULL OR name IN ('AIHOT','上海证券报金融频道'))`,
  );
  await client.query('COMMIT');
  console.log(
    JSON.stringify({
      inserted,
      matched,
      excluded: [
        '中投公司（内部动态）',
        '中国东方资产管理（内部动态）',
        '各银行/AMC官网采购公告（集合项，待拆分）',
      ],
    }),
  );
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
