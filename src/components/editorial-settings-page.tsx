import { requireAdmin } from '../server/auth.ts';
import { getSettings } from '../server/settings.ts';
import { Notice, type Query } from './notice.tsx';
import { EditorialForm } from './editorial-form.tsx';
export async function EditorialSettingsPage({
  searchParams,
  section,
}: {
  searchParams: Promise<Query>;
  section: 'columns' | 'ratings' | 'content';
}) {
  await requireAdmin();
  return (
    <>
      <Notice query={await searchParams} />
      <EditorialForm key={section} section={section} config={await getSettings()} />
    </>
  );
}
