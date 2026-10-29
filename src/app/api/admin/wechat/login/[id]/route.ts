import { z } from 'zod';
import { requireAdmin } from '../../../../../../server/auth.ts';
import { pollWechatLogin } from '../../../../../../server/wechat-auth.ts';
import { wechatApiError } from '../../helpers.ts';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  try {
    const { id } = await context.params;
    return Response.json(await pollWechatLogin(z.uuid().parse(id)));
  } catch (error) {
    return wechatApiError(error);
  }
}
