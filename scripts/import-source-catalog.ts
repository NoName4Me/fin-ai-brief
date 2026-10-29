import { readFile } from 'node:fs/promises';
import { pool } from '../src/server/db.ts';

type Entry = {
  number: number;
  name: string;
  address: string;
  priority: string;
  section: string;
  notes: string | null;
};
const entries: Entry[] = JSON.parse(await readFile('src/data/source-catalog.json', 'utf8'));
const aliases: Record<string, string> = {
  'Hugging Face': 'Hugging Face Blog',
  'InfoQ 中文': 'InfoQ中文',
};
const client = await pool.connect();
const added: string[] = [];
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(76140511)');
  for (const entry of entries) {
    const key = `leader-xlsx:${entry.number}`;
    const existing = await client.query(
      'SELECT id FROM sources WHERE catalog_key=$1 OR name=ANY($2::text[]) ORDER BY (catalog_key=$1) DESC NULLS LAST LIMIT 1',
      [key, [entry.name, aliases[entry.name] ?? entry.name]],
    );
    if (existing.rowCount) {
      // Reordering must preserve configured endpoints, credentials and collection switches.
      await client.query(
        'UPDATE sources SET name=$2,sort_order=$3,catalog_key=coalesce(catalog_key,$4) WHERE id=$1',
        [existing.rows[0].id, entry.name, entry.number, key],
      );
    } else {
      await client.query(
        `INSERT INTO sources(name,url,format,origin_address,industry_id,sections,catalog_key,sort_order,priority,notes,enabled)
        VALUES($1,NULL,'manual',$2,'ai',$3::jsonb,$4,$5,$6,$7,false)`,
        [
          entry.name,
          entry.address,
          JSON.stringify([entry.section]),
          key,
          entry.number,
          entry.priority,
          entry.notes ?? '',
        ],
      );
      added.push(entry.name);
    }
  }
  await client.query("UPDATE sources SET sort_order=2147483647 WHERE name='AIHOT'");
  await client.query('COMMIT');
  console.log(JSON.stringify({ added, ordered: entries.length }));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
