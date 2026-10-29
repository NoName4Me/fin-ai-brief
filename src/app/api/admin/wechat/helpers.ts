import { z } from 'zod';

export function wechatApiError(error: unknown) {
  const message =
    error instanceof z.ZodError
      ? '请求参数有误'
      : error instanceof Error
        ? error.message
        : '操作失败';
  return Response.json({ error: message.slice(0, 500) }, { status: 400 });
}
