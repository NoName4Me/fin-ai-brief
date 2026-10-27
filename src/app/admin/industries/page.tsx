import { redirect } from 'next/navigation';
import { requireAdmin } from '../../../server/auth.ts';
export default async function LegacyIndustries() {
  await requireAdmin();
  redirect('/admin/editorial');
}
