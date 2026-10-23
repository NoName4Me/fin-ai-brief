import { z } from 'zod';
import { newsSnapshot } from '../../../server/publication.ts';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const before = q.get('beforeTime')
    ? z
        .object({ time: z.iso.datetime(), id: z.uuid() })
        .safeParse({ time: q.get('beforeTime'), id: q.get('beforeId') })
    : null;
  if (before && !before.success) return Response.json({ error: '分页参数无效' }, { status: 400 });
  return Response.json(
    await newsSnapshot(
      q.get('industry') ?? undefined,
      (q.get('q') ?? '').slice(0, 100),
      before?.success ? before.data : undefined,
    ),
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
