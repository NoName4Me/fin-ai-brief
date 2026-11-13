import { requireAdmin } from '../../../server/auth.ts';
import { getSettings } from '../../../server/settings.ts';
import { systemSettingsAction } from '../../actions.ts';
import { RetentionSettingsFields } from '../../../components/settings-forms.tsx';
import { Notice, type Query } from '../../../components/notice.tsx';
import { redirect } from 'next/navigation';
import { Save } from 'lucide-react';
export default async function Page({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const query = await searchParams;
  if (query.from && query.to) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (typeof value === 'string') params.set(key, value);
    redirect(`/admin/backfill?${params}`);
  }
  const config = await getSettings();
  return (
    <>
      <Notice query={query} />
      <form action={systemSettingsAction} className="stack-form system-settings-form">
        <RetentionSettingsFields config={config} />
        <button className="solid-button">
          <Save className="icon" strokeWidth={1.75} aria-hidden="true" />
          保存
        </button>
      </form>
    </>
  );
}
