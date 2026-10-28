import { requireAdmin } from '../../../server/auth.ts';
import { SubscriptionPage } from '../../../components/subscription-page.tsx';
import type { Query } from '../../../components/notice.tsx';
export default async function Page({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  return <SubscriptionPage active="subscribers" query={await searchParams} />;
}
