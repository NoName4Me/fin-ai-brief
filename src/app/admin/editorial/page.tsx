import { redirect } from 'next/navigation';
import { requireAdmin } from '../../../server/auth.ts';
import type { Query } from '../../../components/notice.tsx';
export default async function Page({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams))
    if (typeof value === 'string') query.set(key, value);
  redirect(`/admin/editorial/columns${query.size ? `?${query}` : ''}`);
}
