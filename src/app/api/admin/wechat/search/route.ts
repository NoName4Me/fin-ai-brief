import { z } from 'zod';
import { requireAdmin } from '../../../../../server/auth.ts';
import { searchWechatAccounts } from '../../../../../server/wechat.ts';
import { wechatApiError } from '../helpers.ts';

export async function POST(request: Request) {
  await requireAdmin();
  try {
    const { query } = z
      .object({ query: z.string().trim().min(1).max(100) })
      .parse(await request.json());
    return Response.json({ accounts: await searchWechatAccounts(query) });
  } catch (error) {
    return wechatApiError(error);
  }
}
