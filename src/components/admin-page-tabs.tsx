import Link from 'next/link';
function PageTabs({
  label,
  items,
}: {
  label: string;
  items: { href: string; label: string; active: boolean }[];
}) {
  return (
    <nav className="admin-page-tabs" aria-label={label}>
      {items.map((item) => (
        <Link key={item.href} href={item.href} aria-current={item.active ? 'page' : undefined}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
export function PublicationTabs({ active }: { active: 'issues' | 'backfill' }) {
  return (
    <PageTabs
      label="出刊管理页面"
      items={[
        { href: '/admin/publications', label: '刊期列表', active: active === 'issues' },
        { href: '/admin/backfill', label: '手动补刊', active: active === 'backfill' },
      ]}
    />
  );
}
export function SubscriptionTabs({ active }: { active: 'subscribers' | 'history' }) {
  return (
    <PageTabs
      label="订阅与推送页面"
      items={[
        { href: '/admin/subscriptions', label: '订阅', active: active === 'subscribers' },
        { href: '/admin/subscriptions/history', label: '推送记录', active: active === 'history' },
      ]}
    />
  );
}
