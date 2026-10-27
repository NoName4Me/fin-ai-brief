import { readFile } from 'node:fs/promises';
import { pool } from '../src/server/db.ts';
const audit = JSON.parse(await readFile('.data/source-check/ai-daily-rss.json', 'utf8')) as {
  checkedAt: string;
  results: { name: string; url: string; status: string }[];
};
const chosen = ['Hugging Face Blog', 'OpenAI', 'Google DeepMind'];
if (Date.now() - Date.parse(audit.checkedAt) > 7 * 86400000)
  throw new Error('信源核查超过七天，请先重新核查');
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(76140509)');
  for (const name of chosen) {
    const item = audit.results.find((r) => r.name === name && r.status === '可解析');
    if (!item) throw new Error(`${name}没有成功的RSS核查结果`);
    await client.query(
      `INSERT INTO sources(name,url,format,industry_id,enabled,interval_minutes,min_interval_minutes,max_interval_minutes)
      SELECT $1,$2,'rss','ai',true,60,60,240 WHERE NOT EXISTS(SELECT 1 FROM sources WHERE url=$2)`,
      [item.name, item.url],
    );
    console.log(`已配置 ${item.name}；已有来源的启停设置保持原样`);
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
