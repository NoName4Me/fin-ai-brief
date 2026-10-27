import { redirect } from 'next/navigation';
import { requireAdmin } from '../../../server/auth.ts';
export default async function EditionRecords() {
  await requireAdmin();
  redirect('/admin/articles?type=generate');
}
