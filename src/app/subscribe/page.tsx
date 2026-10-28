import Link from 'next/link';
import { SubscribeButton } from '../../components/subscribe-dialog.tsx';
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
        <div className="notice" role="status">
          <p>请前往邮箱，点击确认邮件中的“确认订阅”按钮。确认后订阅才会生效，链接24小时内有效。</p>
          <p>未收到邮件时，请检查垃圾邮件。已生效的订阅无需重复确认。</p>
          <Link href="/subscribe">重新填写邮箱</Link>
        </div>
      ) : (
        <div className="stack-form">
          <p className="muted">提交后需通过邮件确认，每封简报均提供退订入口。</p>
          <SubscribeButton className="solid-button" initiallyOpen>
            邮箱订阅
          </SubscribeButton>
        </div>
      )}
      <p className="back-link">
        <Link href="/">返回简报中心</Link>
      </p>
    </main>
  );
}
