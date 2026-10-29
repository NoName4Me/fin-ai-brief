import { pool } from '../src/server/db.ts';
import { financeSources } from '../src/server/finance-sources.ts';
import { collectSource } from '../src/server/collect.ts';
try {
  for (const source of financeSources) {
    const row = await pool.query(
      `INSERT INTO sources(name,url,format,industry_id,enabled,interval_minutes,next_fetch_at)
      VALUES($1,$2,$3,'finance',true,60,now()+interval '60 minutes') ON CONFLICT(url) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
      [source.name, source.url, source.format],
    );
    try {
      console.log(source.name, await collectSource(row.rows[0].id));
    } catch (error) {
      console.log(source.name, '采集失败：', error instanceof Error ? error.message : '未知错误');
      process.exitCode = 1;
    }
  }
} finally {
  await pool.end();
}
