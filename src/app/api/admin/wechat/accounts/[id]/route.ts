import { z } from 'zod';
import { requireAdmin } from '../../../../../../server/auth.ts';
import { removeWechatAccount, setWechatAccountEnabled } from '../../../../../../server/wechat.ts';
import { wechatApiError } from '../../helpers.ts';

export async function PATCH(
  request: Request,
  context: RouteContext<'/api/admin/wechat/accounts/[id]'>,
) {
  await requireAdmin();
  try {
    const { id } = await context.params;
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await request.json());
    await setWechatAccountEnabled(z.uuid().parse(id), enabled);
    return Response.json({ success: true });
  } catch (error) {
    return wechatApiError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: RouteContext<'/api/admin/wechat/accounts/[id]'>,
) {
  await requireAdmin();
  try {
    const { id } = await context.params;
    await removeWechatAccount(z.uuid().parse(id));
    return Response.json({ success: true });
  } catch (error) {
    return wechatApiError(error);
  }
}
