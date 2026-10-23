import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { eq, gt, and, lt } from 'drizzle-orm';
import { db, pool } from './db.ts';
import { sessions } from './schema.ts';
import { hash } from './crypto.ts';
const cookieName = 'finbrief_admin';
export const isAdmin = cache(async function isAdmin() {
  const token = (await cookies()).get(cookieName)?.value;
  if (!token) return false;
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.hash, hash(token)), gt(sessions.expiresAt, new Date())));
  return Boolean(session);
});
export async function requireAdmin() {
  if (!(await isAdmin())) redirect('/login');
}
export async function login(password: string) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || expected.length < 12) throw new Error('请先配置至少12位的管理员密码');
  const attempts = await pool.query(
    "INSERT INTO login_attempts(key,count,reset_at) VALUES('admin',1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN login_attempts.reset_at<now() THEN 1 ELSE login_attempts.count+1 END, reset_at=CASE WHEN login_attempts.reset_at<now() THEN now()+interval '15 minutes' ELSE login_attempts.reset_at END RETURNING count",
  );
  if (attempts.rows[0].count > 10) throw new Error('登录尝试过多，请15分钟后重试');
  if (
    password.length > 256 ||
    !timingSafeEqual(
      scryptSync(password, 'fin-ai-brief', 32),
      scryptSync(expected, 'fin-ai-brief', 32),
    )
  )
    throw new Error('管理员密码错误');
  await pool.query("DELETE FROM login_attempts WHERE key='admin'");
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  const token = randomBytes(32).toString('base64url');
  await db
    .insert(sessions)
    .values({ hash: hash(token), expiresAt: new Date(Date.now() + 12 * 3600_000) });
  (await cookies()).set(cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(process.env.SITE_URL ?? 'http://localhost:3100').protocol === 'https:',
    maxAge: 12 * 3600,
    path: '/',
  });
}
export async function logout() {
  const store = await cookies();
  const token = store.get(cookieName)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.hash, hash(token)));
  store.delete(cookieName);
}
