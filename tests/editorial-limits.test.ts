import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { admissionThreshold, budgetLimit } from '../src/server/editorial-limits.ts';
import { dailyLengthRepair } from '../src/server/daily-length.ts';
import { highlightErrors } from '../src/server/highlights.ts';
import { defaultSettings, settingsSchema } from '../src/server/types.ts';

test('门槛只在不足时按需放宽，遵守最大降幅且不修改评分', () => {
  const ratings = [4.4, 3.4, 3.3, 3.1];
  assert.equal(admissionThreshold(3.5, ratings, 3, false, 0.3), 3.5);
  assert.equal(admissionThreshold(3.5, ratings, 1, true, 0.3), 3.5);
  assert.equal(admissionThreshold(3.5, ratings, 2, true, 0.3), 3.4);
  assert.equal(admissionThreshold(3.5, ratings, 3, true, 0.3), 3.3);
  assert.equal(admissionThreshold(3.5, ratings, 4, true, 0.3), 3.3);
  assert.equal(admissionThreshold(4.3, [4.2, 4.1, 4.0, 3.9], 3, true, 0.3), 4);
  assert.equal(admissionThreshold(3.5, [3.1], 3, true, 0.3), 3.5);
  assert.deepEqual(ratings, [4.4, 3.4, 3.3, 3.1]);
});

test('按栏目标题摘要合计检查容差，10%内免压缩，超过才压缩', () => {
  const id = randomUUID(),
    other = randomUUID();
  const events = [
    { id, section: '技术' },
    { id: other, section: '技术' },
  ];
  const rules = [{ name: '技术', budget: 100 }];
  const items = [
    { eventId: id, title: '题', summary: '文'.repeat(59) },
    { eventId: other, title: '题', summary: '文'.repeat(49) },
  ];
  assert.equal(budgetLimit(100, 10), 110);
  assert.equal(dailyLengthRepair(items, events, rules, 10), undefined);
  const overflow = items.map((i, index) => (index ? { ...i, summary: i.summary + '字' } : i));
  const repair = dailyLengthRepair(overflow, events, rules, 10)!;
  assert.ok(repair);
  assert.equal(repair.input.sections[0].budget, 100);
  assert.equal('limit' in repair.input.sections[0], false);
  assert.doesNotMatch(repair.system, /容差|limit/);
  assert.equal(repair.schema.safeParse({ items }).success, true);
  assert.equal(repair.schema.safeParse({ items: overflow }).success, false);
  assert.equal(repair.schema.safeParse({ items: items.slice(0, 1) }).success, false);
});

test('要览只控制总预算与容差，不限制单条；旧小条数配置兼容', () => {
  const config = { ...defaultSettings, highlightsBudget: 100, budgetTolerancePercent: 10 };
  assert.deepEqual(highlightErrors([{ text: '文'.repeat(110) }], config), []);
  assert.equal(highlightErrors([{ text: '文'.repeat(111) }], config).length, 1);
  assert.equal(
    highlightErrors([{ text: '摘要' }], { ...config, highlightsDeleted: true }).length,
    1,
  );
  const { highlightsMinItems, ...old } = defaultSettings;
  assert.equal(settingsSchema.parse({ ...old, highlightsMaxItems: 1 }).highlightsMinItems, 1);
  assert.equal(
    settingsSchema.safeParse({ ...defaultSettings, highlightsMinItems: 6 }).success,
    false,
  );
});
