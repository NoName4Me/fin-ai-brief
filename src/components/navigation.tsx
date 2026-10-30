'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logoutAction } from '../app/actions.ts';
import { SubscribeButton } from './subscribe-dialog.tsx';
const items = [
  ['/', '最新日报'],
  ['/archive', '历史日报'],
] as const;
export function Header() {
  const path = usePathname();
  const admin = path === '/admin' || path.startsWith('/admin/');
  return (
    <>
      <header className={`app-header ${admin ? 'admin-header' : 'reader-header'}`}>
        <Link href={admin ? '/admin' : '/'} className="brand">
          <span className="brand-wordmark">
            <span className="brand-wordmark-dark">数智</span>
            <span className="brand-wordmark-light">参阅</span>
          </span>
          {admin && <span className="brand-admin-label">管理台</span>}
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
          <SubscribeButton className="user-menu subscribe-link" />
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
