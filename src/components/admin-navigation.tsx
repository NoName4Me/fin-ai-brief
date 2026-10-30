'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Item = { href: string; label: string };
const editorial: Item[] = [
  { href: '/admin/editorial/columns', label: '整刊配置' },
  { href: '/admin/editorial/ratings', label: '评分规则' },
  { href: '/admin/editorial/content', label: '收录与写作' },
];
const source: Item[] = [
  { href: '/admin/sources', label: '信源管理' },
  { href: '/admin/sources/monitor', label: '信源监控' },
];
export function AdminNavigation() {
  const path = usePathname();
  function group(label: string, items: Item[]) {
    const active =
      items.some((item) => path === item.href) ||
      (label === '信源' && path === '/admin/sources/import');
    return (
      <details className="admin-nav-group" open={active}>
        <summary>{label}</summary>
        <div className="admin-nav-children">
          {items.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              aria-current={
                path === href || (href === '/admin/sources' && path === '/admin/sources/import')
                  ? 'page'
                  : undefined
              }
            >
              {label}
            </Link>
          ))}
        </div>
      </details>
    );
  }
  return (
    <nav aria-label="管理导航">
      <Link href="/admin" aria-current={path === '/admin' ? 'page' : undefined}>
        数据总览
      </Link>
      <Link
        href="/admin/publications"
        aria-current={
          path === '/admin/publications' ||
          path === '/admin/backfill' ||
          path.startsWith('/admin/briefs/')
            ? 'page'
            : undefined
        }
      >
        出刊管理
      </Link>
      {group('信源', source)}
      {group('编辑规则', editorial)}
      <Link
        href="/admin/articles"
        aria-current={path === '/admin/articles' || path === '/admin/jobs' ? 'page' : undefined}
      >
        任务管理
      </Link>
      <Link
        href="/admin/subscriptions"
        aria-current={path.startsWith('/admin/subscriptions') ? 'page' : undefined}
      >
        订阅与推送
      </Link>
      <Link
        href="/admin/settings"
        aria-current={
          path === '/admin/settings' || path === '/admin/retention' ? 'page' : undefined
        }
      >
        系统设置
      </Link>
    </nav>
  );
}
