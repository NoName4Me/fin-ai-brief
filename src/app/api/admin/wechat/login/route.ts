import { requireAdmin } from '../../../../../server/auth.ts';
import { startWechatLogin } from '../../../../../server/wechat-auth.ts';
import { clearWechatCredentials } from '../../../../../server/wechat.ts';
import { wechatApiError } from '../helpers.ts';

export async function POST() {
  await requireAdmin();
  try {
    return Response.json(await startWechatLogin());
  } catch (error) {
    return wechatApiError(error);
  }
}

export async function DELETE() {
  await requireAdmin();
  try {
    await clearWechatCredentials();
    return Response.json({ success: true });
  } catch (error) {
    return wechatApiError(error);
  }
}
