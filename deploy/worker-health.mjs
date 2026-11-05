import { readFile } from 'node:fs/promises';
import pg from 'pg';
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 4000,
  query_timeout: 4000,
});
try {
  const heartbeat = Number(await readFile(process.env.WORKER_HEARTBEAT_PATH, 'utf8'));
  if (!Number.isFinite(heartbeat) || Date.now() - heartbeat > 45000)
    throw new Error('Worker heartbeat expired');
  await client.connect();
  await client.query('SELECT 1');
} catch {
  process.exitCode = 1;
} finally {
  await client.end();
}
