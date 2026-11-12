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

const dataRule = {
  ...rule,
  id: '数据一图／观点摘编',
  name: '数据一图／观点摘编',
  minItems: 1,
  budget: 300,
};
const dataEvents = events.map((event, index) => ({
  ...event,
  developments: [
    {
      ...event.developments[0],
      facts: [
        {
          statement: `研究机构报告：2026年受访机构${['甲', '乙', '丙'][index]}AI采用率为${[30, 45, 60][index]}%。`,
          evidence: `研究机构报告：2026年受访机构${['甲', '乙', '丙'][index]}AI采用率为${[30, 45, 60][index]}%。`,
          status: 'claim',
        },
      ],
    },
  ],
}));
const dataRequest = dailyRotationRequest('2026-11-06', dataRule, dataEvents, '', 10);
const dataText = {
  observation: {
    kind: 'data',
    text: '研究机构报告显示，2026年受访机构甲、乙、丙的AI采用率分别为30%、45%、60%；结果限于该调查样本。',
    eventRefs: ['E01', 'E02', 'E03'],
    basis: [
      { eventRef: 'E01', factRef: 'F1' },
      { eventRef: 'E02', factRef: 'F1' },
      { eventRef: 'E03', factRef: 'F1' },
    ],
    chart: null,
  },
};
const chart = {
  title: '三家受访机构的AI采用率',
  metric: 'AI采用率',
  unit: '%',
  period: '2026年调查样本',
  points: ['甲', '乙', '丙'].map((label, index) => ({
    label,
    value: [30, 45, 60][index],
    eventRef: `E0${index + 1}`,
    factRef: 'F1',
  })),
};

test('数据类可纯文字，配图时核验数据依据，读者名称为数据一图', () => {
  const plain = dataRequest.resolve(dataRequest.schema.parse(dataText));
  assert.equal(plain?.displayName, '数据一图');
  assert.equal(plain?.chart, undefined);
  const withChart = dataRequest.resolve(
    dataRequest.schema.parse({
      observation: { ...dataText.observation, chart },
    }),
  );
  assert.equal(withChart?.chart?.points[0].value, 30);
  assert.equal('eventRef' in withChart!.chart!.points[0], false);
  assert.match(JSON.stringify(dataRequest.input.events[0].developments[0].facts[0]), /"ref":"F1"/);
});

test('观点必须有可核对的具名归属，不能以编辑总结充当来源观点', () => {
  const viewpoint = {
    observation: {
      kind: 'viewpoints',
      text: '研究机构认为该调查样本显示AI采用率存在差异，结果不代表整体行业。',
      eventRefs: ['E01'],
      basis: [{ eventRef: 'E01', factRef: 'F1', speaker: '研究机构' }],
      chart: null,
    },
  };
  assert.equal(dataRequest.resolve(dataRequest.schema.parse(viewpoint))?.displayName, '观点摘编');
  for (const speaker of [undefined, '材料里没有的人']) {
    assert.equal(
      dataRequest.schema.safeParse({
        observation: {
          ...viewpoint.observation,
          basis: [{ eventRef: 'E01', factRef: 'F1', speaker }],
        },
      }).success,
      false,
    );
  }
  assert.equal(
    dataRequest.schema.safeParse({
      observation: { ...viewpoint.observation, chart },
    }).success,
    false,
  );
});

test('拒绝无依据数值、未知事实引用、重复标签以及未选择数据或观点的旧格式', () => {
  assert.equal(dataRequest.schema.safeParse(valid).success, false);
  for (const points of [
    [{ ...chart.points[0], value: 99 }, chart.points[1]],
    [{ ...chart.points[0], factRef: 'F9' }, chart.points[1]],
    [chart.points[0], { ...chart.points[1], label: '甲' }],
  ]) {
    assert.equal(
      dataRequest.schema.safeParse({
        observation: { ...dataText.observation, chart: { ...chart, points } },
      }).success,
      false,
    );
  }
});

test('所有轮动正文拒绝内部引用编号，历史显示可移除标记', async () => {
  const { rotationText } = await import('../src/server/rotation-text.ts');
  assert.equal(
    request.schema.safeParse({
      observation: { ...valid.observation, text: '综合进展（E26）。' },
    }).success,
    false,
  );
  assert.equal(
    rotationText('项目延期（E26）。融资条件变化 (E16、E28)。'),
    '项目延期。融资条件变化。',
  );
  assert.match(request.system, /上周3至5件/);
  const caseStudy = dailyRotationRequest(
    '2026-11-06',
    { ...rule, name: '他山之石' },
    events,
    '',
    10,
  );
  assert.match(caseStudy.system, /只选择一家/);
  const renamed = dailyRotationRequest(
    '2026-11-06',
    { ...dataRule, name: '数据专题' },
    dataEvents,
    '',
    10,
  );
  assert.match(renamed.system, /必须二选一/);
});
