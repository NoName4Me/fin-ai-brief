import { NextResponse } from 'next/server';
import { isAdmin } from '../../../../../server/auth.ts';
import { testManagedModel } from '../../../../../server/model-config.ts';

export async function POST(request: Request) {
  if (!(await isAdmin()))
    return NextResponse.json({ ok: false, response: '请重新登录管理台' }, { status: 401 });
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return NextResponse.json({ ok: false, response: '请求来源无效' }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body.id !== 'string')
    return NextResponse.json({ ok: false, response: '模型参数无效' }, { status: 400 });
  try {
    return NextResponse.json(
      { ok: true, response: await testManagedModel(body.id) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, response: error instanceof Error ? error.message : '连接失败' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
