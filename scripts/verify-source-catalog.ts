import { pool } from '../src/server/db.ts';
import { verifySource } from '../src/server/source-verification.ts';
const { rows } = await pool.query<{ id: string; name: string }>(
  "SELECT id,name FROM sources WHERE catalog_key IS NOT NULL AND NOT enabled AND verification_status='pending' ORDER BY priority,catalog_key",
);
const counts: Record<string, number> = {};
let cursor = 0;
try {
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (cursor < rows.length) {
        const source = rows[cursor++];
        try {
          const result = await verifySource(source.id);
          counts[result.status] = (counts[result.status] ?? 0) + 1;
          console.log(
            JSON.stringify({
              name: source.name,
              status: result.status,
              note: result.note.split('\n')[0],
            }),
          );
        } catch (error) {
          console.log(
            JSON.stringify({
              name: source.name,
              error: error instanceof Error ? error.message : '验证失败',
            }),
          );
        }
      }
    }),
  );
  console.log(JSON.stringify({ total: rows.length, counts }));
} finally {
  await pool.end();
}
