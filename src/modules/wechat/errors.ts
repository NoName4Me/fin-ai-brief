export type WechatErrorCode = 'auth' | 'invalid_account' | 'verification' | 'upstream' | 'format';

export class WechatError extends Error {
  constructor(
    message: string,
    public code: WechatErrorCode = 'upstream',
  ) {
    super(message);
  }
}

export function assertWechatSuccess(payload: unknown) {
  const body = payload as { base_resp?: { ret?: number; err_msg?: string } };
  const ret = body?.base_resp?.ret ?? 0;
  if (ret === 0) return;
  const detail = body.base_resp?.err_msg ?? '';
  if ([200003, 200040].includes(ret) || /invalid session|csrf|login/i.test(detail)) {
    throw new WechatError('微信登录已过期，请重新扫码登录', 'auth');
  }
  if (ret === 200002 && /invalid arg/i.test(detail))
    throw new WechatError('该公众号已失效，请重新搜索添加', 'invalid_account');
  throw new WechatError(`微信接口返回错误（${ret}）${detail ? `：${detail}` : ''}`);
}
