import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyRotationRequest } from '../src/server/daily-rotation.ts';

const rule = {
  name: '一周观察',
  description: '综合三至五个事件',
  keywords: '',
  budget: 10,
  minItems: 3,
  maxItems: 5,
};
const events = [1, 2, 3].map((number) => ({
  id: `event-${number}`,
  industryId: 'ai',
  section: '工具与开源',
  developments: [
    {
      id: `development-${number}`,
      articleId: `article-${number}`,
      reportedAt: new Date('2026-11-01T00:00:00Z'),
      facts: [{ statement: '机构计划开放工具', evidence: '官方称计划开放工具', status: 'planned' }],
    },
  ],
  background: [
    {
      reportedAt: new Date('2026-10-20T00:00:00Z'),
      facts: [{ statement: '旧版本已发布', evidence: '旧公告', status: 'confirmed' }],
    },
  ],
  sources: [
    {
      id: `article-${number}`,
      title: '官方工具公告',
      excerpt: '不必重复传递的大段原文',
      publishedAt: new Date('2026-11-01T00:00:00Z'),
      observedAt: undefined,
      publishedPrecision: 'time',
    },
  ],
}));
const request = dailyRotationRequest('2026-11-02', rule, events, '只依据材料。', 10);
const valid = { observation: { text: '综合三项进展。', eventRefs: ['E01', 'E02', 'E03'] } };

test('轮动输入保留事实、状态、来源时点及背景，移除内部ID和冗长原文', () => {
  const input = JSON.stringify(request.input);
  assert.doesNotMatch(input, /event-1|development-1|article-1|大段原文/);
  assert.deepEqual(request.input.events[0].developments[0], {
    reportedAt: events[0].developments[0].reportedAt,
    facts: events[0].developments[0].facts,
  });
  assert.deepEqual(request.input.events[0].background, events[0].background);
  assert.equal(request.input.events[0].sources[0].publishedAt, events[0].sources[0].publishedAt);
});

test('单栏目短编号准确映射，空材料结果明确留空', () => {
  assert.deepEqual(request.resolve(request.schema.parse(valid)), {
    name: '一周观察',
    text: valid.observation.text,
    eventIds: events.map((event) => event.id),
  });
  assert.equal(request.resolve(request.schema.parse({ observation: null })), null);
});

test('实际错误模式：进展或来源ID被拒绝，反馈明确字段和允许的事件编号', () => {
  for (const id of ['development-1', 'article-1', 'E99']) {
    const result = request.schema.safeParse({
      observation: { ...valid.observation, eventRefs: [id, 'E02', 'E03'] },
    });
    assert.equal(result.success, false);
    if (result.success) continue;
    assert.deepEqual(result.error.issues[0].path, ['observation', 'eventRefs', 0]);
    assert.match(result.error.issues[0].message, /E01.*E02.*E03/);
    assert.doesNotMatch(result.error.message, /字数/);
  }
});

test('实际错误模式：多个分栏、旧格式和自行命名均不接受', () => {
  const split = [1, 2, 3, 4].map((number) => ({
    name: `事件${number}`,
    text: '单事件摘要',
    eventIds: [`article-${number}`],
  }));
  assert.equal(request.schema.safeParse({ rotations: split }).success, false);
  assert.equal(request.schema.safeParse({ observation: split }).success, false);
  assert.equal(
    request.schema.safeParse({ observation: { ...valid.observation, name: '自编栏目' } }).success,
    false,
  );
});

test('引用不足、重复和超长分开反馈，字数容差边界准确', () => {
  assert.throws(
    () => request.schema.parse({ observation: { ...valid.observation, eventRefs: ['E01'] } }),
    /当前引用1个事件.*3至5/,
  );
  assert.throws(
    () =>
      request.schema.parse({
        observation: { ...valid.observation, eventRefs: ['E01', 'E01', 'E02'] },
      }),
    /E01重复/,
  );
  request.schema.parse({ observation: { ...valid.observation, text: '字'.repeat(11) } });
  assert.throws(
    () => request.schema.parse({ observation: { ...valid.observation, text: '字'.repeat(12) } }),
    /当前12字.*上限11字/,
  );
});
