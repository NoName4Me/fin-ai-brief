import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsSchema, defaultSettings } from '../src/server/types.ts';
import { defaultColumns, rotationRules, sectionRuleSchema } from '../src/server/editorial.ts';
import { dailySections } from '../src/server/brief-presentation.ts';
import { renderEmail } from '../src/server/mail-template.ts';
import { fixtureContent } from './fixtures.ts';

test('空白要求补齐、旧关键词归入对应栏目，自定义内容保留', () => {
  const sections = defaultColumns.map((s) => {
    const { keywords, ...legacy } = s;
    void keywords;
    return { ...legacy, description: '' };
  });
  sections[1].description = '自定义技术定位';
  const value = settingsSchema.parse({
    ...defaultSettings,
    keywords: '政策监管：备案；标识\n技术模型：多模态；开源模型',
    sections,
  });
  assert.match(value.sections[0].description, /我司需关注/);
  assert.equal(value.sections[1].description, '自定义技术定位');
  assert.equal(value.sections[0].keywords, '备案；标识');
  assert.equal(value.sections[1].keywords, '多模态；开源模型');
  assert.equal(value.sections[2].keywords, '');
  const explicit = settingsSchema.parse({
    ...value,
    sections: value.sections.map((s) => ({ ...s, keywords: '' })),
  });
  assert.equal(explicit.sections[0].keywords, '');
});

test('轮动共用起刊日期，取材周期自动等于间隔周数乘7', () => {
  const rule = sectionRuleSchema.parse({
    name: '隔周观察',
    kind: 'rotation',
    weekdays: [1, 3],
    intervalWeeks: 2,
    anchorDate: '2000-01-01',
    lookbackDays: 3,
    minItems: 1,
    maxItems: 3,
    budget: 500,
  });
  assert.equal(rotationRules('2026-10-28', '2026-10-27', [rule])[0].scheduled, true);
  assert.equal(rotationRules('2026-11-04', '2026-10-27', [rule])[0].scheduled, false);
  assert.equal(rotationRules('2026-11-11', '2026-10-27', [rule])[0].scheduled, true);
  assert.equal(rotationRules('2026-10-26', '2026-10-27', [rule])[0].scheduled, false);
  assert.equal(rotationRules('2026-10-28', '2026-10-27', [rule])[0].days, 14);
  const config = settingsSchema.parse({
    ...defaultSettings,
    startDate: '2026-10-27',
    sections: [defaultColumns[0], rule],
  });
  assert.equal(config.sections[1].anchorDate, config.startDate);
  assert.equal(config.sections[1].lookbackDays, 14);
});

test('新日报的固定与轮动栏目按保存顺序展示，邮件使用同一顺序', () => {
  const base = fixtureContent();
  const content = {
    ...base,
    format: 'ai-daily-v1' as const,
    items: base.items
      .slice(0, 2)
      .map((item, index) => ({ ...item, industryId: 'ai', section: index ? '栏目乙' : '栏目甲' })),
    rotations: [{ name: '轮动观察', text: '独立轮动正文', sources: base.items[0].sources }],
    sectionOrder: ['栏目乙', '轮动观察', '栏目甲'],
  };
  assert.deepEqual(
    dailySections(content).map((s) => s.name),
    content.sectionOrder,
  );
  const html = renderEmail(
    content,
    'https://example.invalid/issue',
    'https://example.invalid/cancel',
    { kind: 'daily', date: '2026-10-28' },
  );
  assert.ok(html.indexOf('栏目乙') < html.indexOf('轮动观察'));
  assert.ok(html.indexOf('轮动观察') < html.indexOf('栏目甲'));
  const { sectionOrder, ...legacy } = content;
  void sectionOrder;
  assert.deepEqual(
    dailySections(legacy).map((s) => s.name),
    ['栏目甲', '栏目乙', '轮动观察'],
  );
});

test('旧配置补充默认关闭的内部动态，自定义内部栏目和后续删除均保留', () => {
  const { internalColumnInitialized, ...old } = defaultSettings;
  void internalColumnInitialized;
  const sections = defaultColumns.filter((s) => s.name !== '内部动态');
  const migrated = settingsSchema.parse({ ...old, sections });
  const internal = migrated.sections.find((s) => s.name === '内部动态');
  assert.ok(internal);
  assert.equal(internal.enabled, false);
  assert.match(internal.description, /披露边界/);
  const removed = settingsSchema.parse({ ...migrated, sections });
  assert.equal(
    removed.sections.some((s) => s.name === '内部动态'),
    false,
  );
});
