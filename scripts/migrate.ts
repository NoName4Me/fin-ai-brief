import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pool } from '../src/server/db.ts';
import { defaultSettings } from '../src/server/types.ts';
export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(76140501)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of (await readdir('database/migrations'))
      .filter((v) => v.endsWith('.sql'))
      .sort()) {
      const sql = await readFile(`database/migrations/${name}`, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const old = await client.query('SELECT checksum FROM schema_migrations WHERE name=$1', [
        name,
      ]);
      if (old.rows.length) {
        if (old.rows[0].checksum !== checksum) throw new Error(`已应用迁移被修改：${name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [
          name,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      console.log(`Applied ${name}`);
    }
    await client.query('INSERT INTO settings(id,value) VALUES(1,$1) ON CONFLICT DO NOTHING', [
      JSON.stringify(defaultSettings),
    ]);
  } finally {
    await client.query('SELECT pg_advisory_unlock(76140501)');
    client.release();
  }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await migrate();
  } finally {
    await pool.end();
  }
}
