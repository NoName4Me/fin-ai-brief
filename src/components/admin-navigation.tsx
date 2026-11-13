'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  ListChecks,
  Mail,
  Newspaper,
  BrainCircuit,
  Rss,
  Settings,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';

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
  function group(label: string, items: Item[], Icon: LucideIcon) {
    return (
      <div className="admin-nav-group">
        <span className="admin-nav-group-label">
          <Icon className="icon" strokeWidth={1.75} aria-hidden="true" />
          {label}
        </span>
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
      </div>
    );
  }
  return (
    <nav aria-label="管理导航">
      <Link href="/admin" aria-current={path === '/admin' ? 'page' : undefined}>
        <LayoutDashboard className="icon" strokeWidth={1.75} aria-hidden="true" />
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
        <Newspaper className="icon" strokeWidth={1.75} aria-hidden="true" />
        出刊管理
      </Link>
      <Link
        href="/admin/articles"
        aria-current={path === '/admin/articles' || path === '/admin/jobs' ? 'page' : undefined}
      >
        <ListChecks className="icon" strokeWidth={1.75} aria-hidden="true" />
        任务管理
      </Link>
      {group('信源', source, Rss)}
      {group('编辑规则', editorial, SlidersHorizontal)}
      <Link
        href="/admin/subscriptions"
        aria-current={path.startsWith('/admin/subscriptions') ? 'page' : undefined}
      >
        <Mail className="icon" strokeWidth={1.75} aria-hidden="true" />
        订阅与推送
      </Link>
      <Link href="/admin/models" aria-current={path === '/admin/models' ? 'page' : undefined}>
        <BrainCircuit className="icon" strokeWidth={1.75} aria-hidden="true" />
        模型管理
      </Link>
      <Link
        href="/admin/settings"
        aria-current={
          path === '/admin/settings' || path === '/admin/retention' ? 'page' : undefined
        }
      >
        <Settings className="icon" strokeWidth={1.75} aria-hidden="true" />
        系统设置
      </Link>
    </nav>
  );
}
