import { z } from 'zod';
import { requireAdmin } from '../../../../../server/auth.ts';
import { addWechatAccount } from '../../../../../server/wechat.ts';
import { wechatApiError } from '../helpers.ts';

export async function POST(request: Request) {
  await requireAdmin();
  try {
    const account = z
      .object({
        fakeid: z.string().min(1).max(200),
        nickname: z.string().trim().min(1).max(200),
        alias: z.string().max(200),
        avatarUrl: z.string().max(2000),
      })
      .parse(await request.json());
    return Response.json({ account: await addWechatAccount(account) });
  } catch (error) {
    return wechatApiError(error);
  }
}
