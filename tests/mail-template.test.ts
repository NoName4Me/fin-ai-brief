import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEmail } from '../src/server/mail-template.ts';
import { fixtureContent } from './fixtures.ts';
test('邮件带入真实刊期日期与期号，按行业分组并保留摘要重点', () => {
  const content = fixtureContent();
  const phrase = content.items[0].summary.slice(0, 8);
  content.items[0].emphasis = [phrase];
  const html = renderEmail(
    content,
    'https://example.invalid/brief',
    'https://example.invalid/unsubscribe',
    {
      kind: 'daily',
      date: '2026-10-26',
      issueNumber: 5,
      industries: [
        { id: 'finance', name: '金融行业', sections: ['行业监管'] },
        { id: 'ai', name: '人工智能', sections: ['AI 模型'] },
      ],
    },
  );
  assert.ok(html.includes('第005期'));
  assert.ok(html.includes('2026年10月'));
  assert.ok(html.includes('星期一'));
  assert.ok(html.includes('金融行业要情'));
  assert.ok(html.includes('人工智能要情'));
  assert.ok(html.includes(`font-weight:700;color:#2b3033">${phrase}</strong>`));
  assert.equal((html.match(/<h3 /g) ?? []).length, content.items.length);
  assert.ok(!html.includes('display:grid'));
});
test('周报月报采用各自刊头、主线和时间轴，未知行业也不遗漏', () => {
  const content = fixtureContent();
  content.items[0].industryId = 'custom';
  content.overview.custom = '<img src=x onerror=alert(1)>';
  for (const [kind, name, focus, timeline] of [
    ['weekly', '数智参阅·周报', '金融要情', '一周进程'],
    ['monthly', '数智参阅·月报', '金融要情', '月内时间轴'],
  ] as const) {
    const html = renderEmail(
      content,
      'https://example.invalid/brief',
      'https://example.invalid/unsubscribe',
      { kind, issueNumber: 2 },
    );
    for (const text of [name, focus, timeline, content.items[0].title])
      assert.ok(html.includes(text));
    assert.ok(html.includes('&lt;img'));
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('第002期'));
  }
});

test('新版日报邮件采用单栏、三列刊期信息、纯星级及双线下方的本期完', () => {
  const content = fixtureContent();
  content.format = 'ai-daily-v1';
  content.items = content.items.map((item) => ({ ...item, rating: 4.5 }));
  content.highlights = [{ eventId: content.items[0].eventId, text: '本期要览', rating: 4.5 }];
  const html = renderEmail(
    content,
    'https://example.invalid/issue',
    'https://example.invalid/cancel',
    { date: '2026-10-28', issueNumber: 7 },
  );
  assert.ok(html.includes('主办：数智化转型办公室 AI工作组'));
  assert.ok(html.includes('《数智参阅》第007期'));
  assert.ok(html.includes('aria-label="4.5分，满分5分"'));
  assert.ok(!html.includes('4.5/5'));
  assert.ok(!html.includes('<td class="email-calendar"'));
  assert.ok(!html.includes('<td class="email-stack"'));
  assert.ok(!html.includes('统计范围：'));
  assert.ok(!html.includes('编制'));
  assert.match(html, /class="email-footer"[^>]*border-top:3px double[^>]*>.*本期完/s);
});
