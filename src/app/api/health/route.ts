import { pool } from '../../../server/db.ts';
export async function GET() {
  try {
    await pool.query('SELECT 1');
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
