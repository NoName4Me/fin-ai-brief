import Link from 'next/link';
import { subscribeAction } from '../actions.ts';
import { Notice, type Query } from '../../components/notice.tsx';
export const metadata = { title: '邮箱订阅', robots: { index: false, follow: false } };
export default async function Subscribe({ searchParams }: { searchParams: Promise<Query> }) {
  const q = await searchParams;
  return (
    <main className="form-page">
      <div className="view-header">
        <div>
          <h1>邮箱订阅</h1>
          <p>每日AI资讯，发送到你的邮箱。</p>
        </div>
      </div>
      <Notice query={q} />
      {q.registered ? (
        <div className="notice">
          <p>
            邮箱已登记。
            {process.env.MAIL_ENABLED === 'true'
              ? '正式简报发布后按订阅类型发送。'
              : '正式邮件服务尚未启用，接通后开始发送。'}
          </p>
          {typeof q.token === 'string' && (
            <p>
              <Link href={`/unsubscribe?token=${encodeURIComponent(q.token)}`}>
                保存这个退订链接
              </Link>
              ，之后可随时取消。
            </p>
          )}
        </div>
      ) : (
        <form action={subscribeAction} className="stack-form">
          <label>
            邮箱地址
            <input name="email" type="email" autoComplete="email" maxLength={254} required />
          </label>
          <input type="hidden" name="kinds" value="daily" />
          <label className="honey" aria-hidden="true">
            Website
            <input name="website" tabIndex={-1} autoComplete="off" />
          </label>
          <p className="muted">仅用于发送所选简报。每封邮件提供退订入口。</p>
          <button className="solid-button">登记订阅</button>
        </form>
      )}
      <p className="back-link">
        <Link href="/">返回简报中心</Link>
      </p>
    </main>
  );
}
