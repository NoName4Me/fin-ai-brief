import { requireAdmin } from '../../../server/auth.ts';
import { getSettings } from '../../../server/settings.ts';
import { Notice, type Query } from '../../../components/notice.tsx';
import { EditorialForm } from '../../../components/editorial-form.tsx';
export default async function Editorial({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const config = await getSettings();
  return (
    <>
      <Notice query={await searchParams} />
      <EditorialForm config={config} />
    </>
  );
}
