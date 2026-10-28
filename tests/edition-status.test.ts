import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixedSectionOutcome, explainEditionRecord } from '../src/server/edition-status.ts';
import { cleanBriefTitle } from '../src/server/brief-title.ts';
import { highlightErrors } from '../src/server/highlights.ts';

test('低分候选正常留空，不受其他资讯失败影响；无候选明确标记待核查', () => {
  const input = {
    candidates: 2,
    qualified: 0,
    selected: 0,
    unscored: 0,
    published: true,
    health: { processing_errors: 11, source_errors: 0, unassessed: 0 },
  };
  assert.equal(fixedSectionOutcome(input).status, 'skipped');
  const empty = fixedSectionOutcome({ ...input, candidates: 0 });
  assert.equal(empty.status, 'error');
  assert.match(empty.reason, /11篇资讯处理未完成或失败/);
  assert.match(empty.reason, /缺稿原因待核查/);
  assert.equal(fixedSectionOutcome({ ...input, unscored: 1 }).status, 'error');
});

test('旧记录修正低分误报，保留此前确实刊登的任务快照', () => {
  const record = {
    status: 'error',
    candidate_count: 2,
    selected_count: 0,
    reason: '采集或处理存在异常，不能判定为正常无内容',
    details: [3.2, 3.1].map((rating) => ({ rating, selected: false, reason: '未达到入选分数' })),
  };
  assert.equal(explainEditionRecord(record).status, 'skipped');
  const published = { ...record, status: 'published', selected_count: 2 };
  assert.deepEqual(explainEditionRecord(published), published);
  assert.match(
    explainEditionRecord({ ...record, candidate_count: 0, details: [] }, 11).reason,
    /本批次有11条资讯处理失败/,
  );
});

test('标题只移除前缀；要览按配置检查开关、条数和字数', () => {
  assert.equal(cleanBriefTitle('AI日报｜AI日报| 今日动态'), '今日动态');
  assert.equal(cleanBriefTitle('数智参阅｜今日动态'), '今日动态');
  assert.equal(cleanBriefTitle('《数智参阅》第001期｜今日动态'), '今日动态');
  assert.equal(cleanBriefTitle('模型与AI日报工具'), '模型与AI日报工具');
  const config = {
    highlightsEnabled: true,
    highlightsMaxItems: 2,
    highlightsBudget: 6,
  };
  assert.deepEqual(highlightErrors([{ text: '一个要览' }], config), []);
  assert.equal(
    highlightErrors([{ text: '一个要览' }], { ...config, highlightsEnabled: false }).length,
    1,
  );
  assert.equal(
    highlightErrors([{ text: '五个字以上' }, { text: '第二条' }, { text: '第三条' }], config)
      .length,
    2,
  );
});
