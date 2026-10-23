import { requireAdmin } from '../../server/auth.ts';
import { AdminNavigation } from '../../components/admin-navigation.tsx';
export const metadata = { title: '管理台', robots: { index: false, follow: false } };
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <AdminNavigation />
      </aside>
      <main className="admin-main">{children}</main>
    </div>
  );
}
