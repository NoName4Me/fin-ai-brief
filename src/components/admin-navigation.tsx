'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
const items = [
  ['/admin', '简报工作台'],
  ['/admin/articles', '任务管理'],
  ['/admin/sources', '信源'],
  ['/admin/industries', '行业与栏目'],
  ['/admin/settings', '出刊设置'],
  ['/admin/subscriptions', '订阅管理'],
  ['/admin/retention', '数据保留'],
] as const;
export function AdminNavigation() {
  const path = usePathname();
  return (
    <nav aria-label="管理导航">
      {items.map(([href, label]) => {
        const active =
          href === '/admin'
            ? path === '/admin' || path.startsWith('/admin/briefs/')
            : path === href || (href === '/admin/articles' && path === '/admin/jobs');
        return (
          <Link key={href} href={href} aria-current={active ? 'page' : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
