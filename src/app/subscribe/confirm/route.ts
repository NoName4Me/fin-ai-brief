import { NextResponse } from 'next/server';
import { confirmSubscription } from '../../../server/subscription-confirmation.ts';

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  const status = await confirmSubscription(token);
  // Keep the browser's public origin; Next's internal request URL may use localhost.
  const response = new NextResponse(null, {
    status: 303,
    headers: { Location: `/subscribe/confirmed?${new URLSearchParams({ status })}` },
  });
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
