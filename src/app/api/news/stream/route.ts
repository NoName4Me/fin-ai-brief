import { newsChanges } from '../../../../server/publication.ts';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  let cursor = request.headers.get('last-event-id') ?? q.get('since') ?? '0';
  if (!/^\d{1,18}$/.test(cursor)) return Response.json({ error: '游标无效' }, { status: 400 });
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined,
    closed = false;
  const stream = new ReadableStream({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        request.signal.removeEventListener('abort', close);
        controller.close();
      };
      request.signal.addEventListener('abort', close, { once: true });
      const tick = async () => {
        if (closed) return;
        try {
          const data = await newsChanges(
            cursor,
            q.get('industry') ?? undefined,
            (q.get('q') ?? '').slice(0, 100),
          );
          if (closed) return;
          cursor = data.cursor;
          controller.enqueue(
            encoder.encode(
              data.changed.length
                ? `id: ${cursor}\nevent: update\ndata: ${JSON.stringify(data)}\n\n`
                : ': heartbeat\n\n',
            ),
          );
          timer = setTimeout(tick, 2000);
        } catch {
          close();
        }
      };
      controller.enqueue(encoder.encode('retry: 3000\n\n'));
      void tick();
    },
    cancel() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}
