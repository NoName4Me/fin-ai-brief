import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { renderEmail } from '../../src/server/mail-template.ts';

test('数据图表在网页、手机和邮件中显示实际栏目名、数值与来源', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const row = (
    await db.query(
      "SELECT id,published FROM briefs WHERE kind='daily' AND published IS NOT NULL ORDER BY period_date DESC LIMIT 1",
    )
  ).rows[0];
  const content = {
    ...row.published,
    rotations: [
      {
        name: '数据一图／观点摘编',
        displayName: '数据一图',
        text: '研究机构调查显示，三家受访机构采用率存在差异；结果仅限该调查样本（E26）。',
        chart: {
          title: '三家受访机构的AI采用率',
          metric: 'AI采用率',
          unit: '%',
          period: '2026年调查样本',
          points: [
            { label: '机构甲', value: 30 },
            { label: '机构乙', value: 45 },
            { label: '机构丙', value: 60 },
          ],
        },
        sources: [
          {
            name: '研究机构',
            title: 'AI采用调查报告',
            url: 'https://example.invalid/report',
            publishedAt: '2026-11-01',
          },
        ],
      },
    ],
  };
  try {
    await db.query('UPDATE briefs SET published=$2 WHERE id=$1', [row.id, JSON.stringify(content)]);
    await page.goto(`/briefs/${row.id}`);
    await expect(page.locator('.daily-rotation .chapter-heading > h2')).toHaveText('数据一图');
    await expect(page.locator('.rotation-chart-bars li')).toHaveCount(3);
    await expect(page.locator('.rotation-chart-context')).toContainText('AI采用率（%）');
    await expect(page.locator('.rotation-copy')).not.toContainText('E26');
    await expect(page.getByRole('link', { name: '数据一图', exact: true })).toBeVisible();
    await page.locator('.daily-rotation').screenshot({ path: '.data/rotation-chart-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.locator('.daily-rotation').screenshot({ path: '.data/rotation-chart-mobile.png' });
    const html = renderEmail(
      content,
      'https://example.invalid/brief',
      'https://example.invalid/unsubscribe',
      {
        kind: 'daily',
        date: '2026-11-06',
      },
    );
    await page.setContent(html);
    await expect(page.getByRole('heading', { name: '数据一图', exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: '三家受访机构的AI采用率' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('E26');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page
      .getByRole('img', { name: '三家受访机构的AI采用率' })
      .screenshot({ path: '.data/rotation-chart-email.png' });
  } finally {
    await db.query('UPDATE briefs SET published=$2 WHERE id=$1', [row.id, row.published]);
    await db.end();
  }
});
