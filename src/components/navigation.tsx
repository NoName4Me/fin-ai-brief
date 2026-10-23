'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logoutAction } from '../app/actions.ts';
const items = [
  ['/', '简报中心'],
  ['/archive', '历史简报'],
  ['/news', '7×24资讯'],
] as const;
export function Header() {
  const path = usePathname();
  const admin = path === '/admin' || path.startsWith('/admin/');
  return (
    <>
      <header className={`app-header ${admin ? 'admin-header' : ''}`}>
        <Link href={admin ? '/admin' : '/'} className="brand">
          <div>
            <div className="brand-name">{admin ? 'Fin&AI 管理台' : 'Fin&AI简报'}</div>
            {!admin && <div className="brand-sub">金融与AI资讯简报</div>}
          </div>
        </Link>
        {!admin && (
          <nav className="primary-nav" aria-label="主导航">
            {items.map(([href, label]) => (
              <Link
                key={href}
                href={href}
                aria-current={
                  (href === '/' ? path === '/' || path.startsWith('/briefs/') : path === href)
                    ? 'page'
                    : undefined
                }
              >
                {label}
              </Link>
            ))}
          </nav>
        )}
        {admin ? (
          <form action={logoutAction} className="user-menu admin-logout">
            <button type="submit" className="quiet-button">
              退出管理台
            </button>
          </form>
        ) : (
          <Link href="/subscribe" className="user-menu subscribe-link">
            邮箱订阅
          </Link>
        )}
      </header>
      {!admin && (
        <nav className="mobile-nav" aria-label="手机导航">
          {items.map(([href, label]) => (
            <Link
              key={href}
              href={href}
              aria-current={
                (href === '/' ? path === '/' || path.startsWith('/briefs/') : path === href)
                  ? 'page'
                  : undefined
              }
            >
              {label}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}
export function PrintButton() {
  return (
    <button className="source-link" onClick={() => window.print()}>
      打印本期
    </button>
  );
}
