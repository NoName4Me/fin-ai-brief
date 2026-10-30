'use server';
import { requireAdmin } from '../server/auth.ts';
import { revalidatePath } from 'next/cache';
import { saveBriefEdit, rewriteBriefField } from '../server/brief-editing.ts';
export async function saveBriefEditAction(input: unknown, mode: 'save' | 'publish') {
  await requireAdmin();
  try {
    if (!['save', 'publish'].includes(mode)) throw new Error('无效操作');
    const result = await saveBriefEdit(input, mode === 'publish');
    revalidatePath('/', 'layout');
    return { ok: true as const, ...result };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : '保存失败' };
  }
}
export async function rewriteBriefFieldAction(
  input: unknown,
  field: unknown,
  previous: string[] = [],
) {
  await requireAdmin();
  try {
    return { ok: true as const, text: await rewriteBriefField(input, field, previous) };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : '重写失败' };
  }
}
