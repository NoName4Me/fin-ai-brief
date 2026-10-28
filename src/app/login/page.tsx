import { redirect } from 'next/navigation';
import { loginAction } from '../actions.ts';
import { isAdmin } from '../../server/auth.ts';
import { Notice, type Query } from '../../components/notice.tsx';
export const metadata = { title: '管理员登录', robots: { index: false, follow: false } };
export default async function Login({ searchParams }: { searchParams: Promise<Query> }) {
  if (await isAdmin()) redirect('/admin');
  return (
    <main className="form-page">
      <div className="view-header">
        <div>
          <h1>管理员登录</h1>
          <p>登录后进入管理台。</p>
        </div>
      </div>
      <Notice query={await searchParams} />
      <form action={loginAction} className="stack-form">
        <label>
          管理员密码
          <input
            type="password"
            name="password"
            required
            maxLength={256}
            autoComplete="current-password"
          />
        </label>
        <button className="solid-button">登录</button>
      </form>
    </main>
  );
}
