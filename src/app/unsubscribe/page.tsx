import Link from 'next/link';
import { unsubscribeAction } from '../actions.ts';
import { Notice, type Query } from '../../components/notice.tsx';
export const metadata = { title: '取消订阅', robots: { index: false, follow: false } };
export default async function Unsubscribe({ searchParams }: { searchParams: Promise<Query> }) {
  const q = await searchParams;
  return (
    <main className="form-page">
      <div className="view-header">
        <h1>取消订阅</h1>
      </div>
      <Notice query={q} />
      {!q.notice && (
        <form action={unsubscribeAction} className="stack-form">
          <p>确认后，这个邮箱将停止接收简报。</p>
          <label>
            退订凭据
            <input
              name="token"
              defaultValue={typeof q.token === 'string' ? q.token : ''}
              required
              maxLength={150}
            />
          </label>
          <button className="solid-button">确认退订</button>
        </form>
      )}
      <p className="back-link">
        <Link href="/">返回简报中心</Link>
      </p>
    </main>
  );
}
