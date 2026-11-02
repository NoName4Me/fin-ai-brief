import { test, expect } from '@playwright/test';

test('邮箱确认跳转保留外部访问地址，不使用内部localhost', async ({ request }) => {
  const response = await request.get('/subscribe/confirm?token=invalid', {
    headers: { Host: '10.1.112.146:3101' },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
  expect(response.headers().location).toBe('/subscribe/confirmed?status=invalid');
  expect(response.headers()['referrer-policy']).toBe('no-referrer');
  expect(response.headers()['cache-control']).toBe('no-store');
});
