import { NextResponse } from 'next/server';
import { confirmSubscription } from '../../../server/subscription-confirmation.ts';

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  const status = await confirmSubscription(token);
  const target = new URL('/subscribe/confirmed', request.url);
  target.searchParams.set('status', status);
  const response = NextResponse.redirect(target);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
