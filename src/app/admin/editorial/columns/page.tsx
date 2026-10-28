import { EditorialSettingsPage } from '../../../../components/editorial-settings-page.tsx';
import type { Query } from '../../../../components/notice.tsx';
export default function Page({ searchParams }: { searchParams: Promise<Query> }) {
  return <EditorialSettingsPage section="columns" searchParams={searchParams} />;
}
