import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderedSources, sourceName, sourceNames } from '../src/server/source-presentation.ts';

test('读者来源名称去除采集方式后缀，保留实质性名称说明', () => {
  for (const name of [
    '新华网（网页）',
    '新华网(RSS)',
    '新华网（RSS · 排除企业/客户案例）',
    '新华网（网页）（RSS）',
  ])
    assert.equal(sourceName(name), '新华网');
  assert.equal(sourceName('Wiz：Research（安全研究）'), 'Wiz：Research（安全研究）');
});
test('来源排序将X和Twitter放最后，保留所有链接且不改动原始快照', () => {
  const sources = [
    { name: 'X: Person', url: 'https://x.com/person/status/1' },
    { name: '新华社（RSS）', url: 'https://example.invalid/first' },
    { name: '某机构（网页）', url: 'https://example.invalid/second' },
    { name: '另一来源', url: 'https://mobile.twitter.com/person/status/2' },
    { name: '新华社（网页）', url: 'https://example.invalid/third' },
  ];
  const ordered = orderedSources(sources);
  assert.deepEqual(
    ordered.map((source) => source.url),
    [sources[1].url, sources[2].url, sources[4].url, sources[0].url, sources[3].url],
  );
  assert.equal(ordered.length, sources.length);
  assert.equal(sources[0].name, 'X: Person');
  assert.deepEqual(sourceNames(sources), ['新华社', '某机构', 'X: Person', '另一来源']);
});
