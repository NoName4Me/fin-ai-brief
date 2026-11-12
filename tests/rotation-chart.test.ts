import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RotationChart } from '../src/components/rotation-chart.tsx';
import { renderEmail } from '../src/server/mail-template.ts';
import { rotationChartSchema } from '../src/server/rotation-chart.ts';
import { DailyBrief } from '../src/components/daily-brief.tsx';
import { fixtureContent } from './fixtures.ts';

const chart = rotationChartSchema.parse({
  title: '两家受访机构的AI采用率',
  metric: 'AI采用率',
  unit: '%',
  period: '2026年调查样本',
  points: [
    { label: '机构甲', value: 30 },
    { label: '机构乙', value: 45 },
  ],
});
test('图表保留准确数值、单位、时期，零值和小数可正常显示', () => {
  const html = renderToStaticMarkup(createElement(RotationChart, { chart }));
  for (const text of ['机构甲', '机构乙', '30', '45', '%', '2026年调查样本'])
    assert.ok(html.includes(text));
  const small = {
    ...chart,
    points: [
      { label: '甲', value: 0 },
      { label: '乙', value: 0.25 },
    ],
  };
  const smallHtml = renderToStaticMarkup(createElement(RotationChart, { chart: small }));
  assert.match(smallHtml, /width:0%/);
  assert.match(smallHtml, /width:100%/);
  assert.match(smallHtml, /0.25/);
});

test('网页和邮件使用实际类型栏目名、图表和来源，历史内部编号不再露出', () => {
  const content = fixtureContent();
  content.format = 'ai-daily-v1';
  content.rotations = [
    {
      name: '数据一图／观点摘编',
      displayName: '数据一图',
      chart,
      text: '两家受访机构的AI采用率分别为30%和45%（E26）。',
      sources: [
        {
          name: '研究机构',
          title: '调查报告',
          url: 'https://example.invalid/report',
          publishedAt: '2026-11-01',
        },
      ],
    },
  ];
  const web = renderToStaticMarkup(createElement(DailyBrief, { content, date: '2026-11-06' }));
  const email = renderEmail(
    content,
    'https://example.invalid/brief',
    'https://example.invalid/unsubscribe',
    {
      kind: 'daily',
      date: '2026-11-06',
    },
  );
  for (const html of [web, email]) {
    assert.match(html, /数据一图/);
    assert.match(html, /两家受访机构的AI采用率/);
    assert.match(html, /2026年调查样本/);
    assert.match(html, /研究机构/);
    assert.doesNotMatch(html, /E26/);
  }
  assert.ok(email.includes('background:'));
  assert.ok(!email.includes('display:grid'));
  content.rotations[0] = {
    ...content.rotations[0],
    displayName: '观点摘编',
    chart: undefined,
  };
  const noChart = renderToStaticMarkup(createElement(DailyBrief, { content, date: '2026-11-06' }));
  assert.match(noChart, />观点摘编</);
  assert.doesNotMatch(noChart, /rotation-chart-bars/);
});
