import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';
const shared = globalThis as typeof globalThis & { briefPool?: pg.Pool };
export const pool = (shared.briefPool ??= new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
}));
export const db = drizzle(pool, { schema });
