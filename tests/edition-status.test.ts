import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixedSectionOutcome, explainEditionRecord } from '../src/server/edition-status.ts';
import { cleanBriefTitle } from '../src/server/brief-title.ts';
import { highlightErrors } from '../src/server/highlights.ts';

test('低分候选正常留空，无候选自动说明候选材料不完整的可能原因', () => {
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
  assert.match(empty.reason, /候选材料不完整/);
  assert.doesNotMatch(empty.reason, /待核查/);
  const historical = explainEditionRecord({
    status: 'error',
    candidate_count: 0,
    selected_count: 0,
    reason: '本期有52篇资讯处理未完成或失败；本栏目暂无候选，缺稿原因待核查',
  });
  assert.match(historical.reason, /可能因本期有52篇资讯处理未完成或失败/);
  assert.doesNotMatch(historical.reason, /待核查/);
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

test('单栏目超长不能把同一异常归给其他栏目，兼容既有任务快照', () => {
  const reason = JSON.stringify([
    { code: 'custom', message: '技术与模型超过440字上限（含容差）（449字）', path: [] },
  ]);
  const record = {
    status: 'error',
    section: '政策与监管',
    candidate_count: 0,
    selected_count: 0,
    reason,
  };
  const other = explainEditionRecord(record);
  assert.equal(other.status, 'blocked');
  assert.match(other.reason, /整期.*技术与模型/);
  assert.doesNotMatch(other.reason, /449|440/);
  const failed = explainEditionRecord({ ...record, section: '技术与模型' });
  assert.equal(failed.status, 'error');
  assert.match(failed.reason, /449/);
});
