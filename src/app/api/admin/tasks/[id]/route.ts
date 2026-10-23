import { NextResponse } from 'next/server';
import { isAdmin } from '../../../../../server/auth.ts';
import { taskDetail } from '../../../../../server/admin-tasks.ts';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: '请重新登录管理台' }, { status: 401 });
  const { id } = await params;
  try {
    const detail = await taskDetail(id);
    return detail
      ? NextResponse.json(detail, { headers: { 'Cache-Control': 'no-store' } })
      : NextResponse.json({ error: '任务不存在' }, { status: 404 });
  } catch {
    return NextResponse.json({ error: '读取任务详情失败，请重试' }, { status: 400 });
  }
}
