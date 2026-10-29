import { redirect } from 'next/navigation';
import { requireAdmin } from '../../../server/auth.ts';
import type { Query } from '../../../components/notice.tsx';
export default async function Backfill({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const query = await searchParams;
  const params = new URLSearchParams({ configure: 'backfill' });
  for (const [key, value] of Object.entries(query))
    if (typeof value === 'string') params.set(key, value);
  redirect(`/admin/publications?${params}`);
}
