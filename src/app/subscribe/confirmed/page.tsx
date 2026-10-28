import Link from 'next/link';
import type { Query } from '../../../components/notice.tsx';
export const metadata = {
  title: '订阅确认',
  robots: { index: false, follow: false },
  referrer: 'no-referrer' as const,
};
export default async function Page({ searchParams }: { searchParams: Promise<Query> }) {
  const { status } = await searchParams;
  const success = status === 'success';
  const expired = status === 'expired';
  return (
    <main className="form-page">
      <div className="view-header">
        <h1>{success ? '订阅已确认' : expired ? '确认链接已过期' : '确认链接无效'}</h1>
      </div>
      <div className="notice" role="status">
        <p>
          {success
            ? '你已成功订阅《数智参阅》，新一期发布后将发送到你的邮箱。'
            : expired
              ? '此链接已超过24小时，请重新提交邮箱获取确认邮件。'
              : '请使用最新确认邮件中的完整链接，或重新提交邮箱。'}
        </p>
      </div>
      <Link className="solid-button" href={success ? '/' : '/subscribe'}>
        {success ? '阅读数智参阅' : '重新订阅'}
      </Link>
      {success && <p className="muted">每封邮件均可取消订阅。</p>}
    </main>
  );
}
