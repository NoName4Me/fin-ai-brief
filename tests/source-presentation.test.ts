import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SourceRow } from '../src/components/brief-story.tsx';
test('同媒体的多篇依据合并为一个来源名，弹窗保留不同文章并去除相同链接', () => {
  const first = {
    name: '虎嗅',
    url: 'https://example.invalid/one',
    title: '第一篇依据',
    publishedAt: '2026-10-29T01:00:00Z',
  };
  const second = {
    ...first,
    name: '虎嗅（网页）',
    url: 'https://example.invalid/two',
    title: '第二篇依据',
  };
  const html = renderToStaticMarkup(
    createElement(SourceRow, {
      item: { title: '数据一图／观点摘编', sources: [first, second, first] },
    }),
  );
  assert.equal((html.split('<dialog')[0].match(/虎嗅/g) ?? []).length, 1);
  assert.match(html, /来源与依据/);
  assert.match(html, /第一篇依据/);
  assert.match(html, /第二篇依据/);
  assert.equal((html.match(/href="https:\/\/example.invalid\/one"/g) ?? []).length, 1);
});
