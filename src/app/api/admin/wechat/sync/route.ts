import { z } from 'zod';
import { requireAdmin } from '../../../../../server/auth.ts';
import { enqueue } from '../../../../../server/queue.ts';
import { wechatApiError } from '../helpers.ts';

export async function POST(request: Request) {
  await requireAdmin();
  try {
    const { sourceId } = z.object({ sourceId: z.uuid() }).parse(await request.json());
    await enqueue('collect', { id: sourceId, manual: true }, sourceId);
    return Response.json({ success: true });
  } catch (error) {
    return wechatApiError(error);
  }
}
