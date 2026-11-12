import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  selectPublicationCandidates,
  publicationDecisionSchema,
  recallPublishedReports,
  type PublicationDecision,
} from '../src/server/publication-dedup.ts';

const decision = (kind: PublicationDecision['decision']): PublicationDecision => ({
  decision: kind,
  previousEventId: kind === 'new' ? null : randomUUID(),
  newFactIndexes: kind === 'update' ? [0] : [],
  reason: '测试判定',
});
const events = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: String(i), title: '事件' + i, summary: '材料' }));

test('每栏仅保留上限加2，原候选和补位均重复后不再递补', async () => {
  const checked: string[] = [];
  const result = await selectPublicationCandidates(events(20), 2, async (event) => {
    checked.push(event.id);
    return decision('duplicate');
  });
  assert.deepEqual(checked, ['0', '2', '1', '3']);
  assert.equal(result.selected.length, 0);
  assert.equal(result.decisions.size, 4);
});

test('每个名额只补一位，其他原候选仍会检查，候选不足不凑数', async () => {
  const checked: string[] = [];
  const result = await selectPublicationCandidates(events(8), 3, async (event) => {
    checked.push(event.id);
    return decision(event.id === '2' ? 'update' : 'duplicate');
  });
  assert.deepEqual(checked, ['0', '3', '1', '4', '2']);
  assert.deepEqual(
    result.selected.map((event) => event.id),
    ['2'],
  );
});

test('原候选通过后不检查备选，预览缓存缺失不调用额外候选', async () => {
  let calls = 0;
  const result = await selectPublicationCandidates(events(8), 3, async () => {
    calls++;
    return undefined;
  });
  assert.equal(calls, 3);
  assert.equal(result.cached, false);
  assert.equal(result.selected.length, 3);
});

test('进展必须指向已刊事件和真实新增事实索引', () => {
  const previous = randomUUID();
  const schema = publicationDecisionSchema([previous], 2);
  const valid = { ...decision('update'), previousEventId: previous };
  assert.equal(schema.safeParse(valid).success, true);
  for (const bad of [
    { ...valid, previousEventId: randomUUID() },
    { ...valid, newFactIndexes: [] },
    { ...valid, newFactIndexes: [2] },
    { ...valid, newFactIndexes: [0, 0] },
    { ...valid, decision: 'new' },
    { ...valid, decision: 'duplicate' },
  ])
    assert.equal(schema.safeParse(bad).success, false);
});

test('历史按事件合并多期报道，召回24个事件并保留同ID，换ID也可按文本召回', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({
    date: '2026-11-01',
    eventId: String(i),
    title: '无关' + i,
    summary: '无关内容',
  }));
  history.push(
    {
      date: '2026-11-02',
      eventId: 'old',
      title: '某模型正式开放代码',
      summary: '模型开放代码和权重',
    },
    { date: '2026-11-03', eventId: 'old', title: '某模型增加商用许可', summary: '商用条件改变' },
  );
  const recalled = recallPublishedReports(
    { id: '29', title: '某模型正式开放代码', summary: '模型开放代码和权重' },
    history,
  );
  assert.equal(recalled.length, 24);
  assert.equal(recalled[0].eventId, '29');
  assert.equal(recalled.find((event) => event.eventId === 'old')?.reports.length, 2);
});

test('事实索引越界时纠错明确给出合法范围，模型可在同次请求中修正', async () => {
  const { requestModel } = await import('../src/server/model.ts');
  const previous = randomUUID();
  let attempts = 0;
  const result = await requestModel(
    '检查进展',
    { facts: Array.from({ length: 25 }, (_, index) => ({ statement: '事实' + index })) },
    publicationDecisionSchema([previous], 25),
    { model: 'test', apiKey: 'test', baseUrl: 'http://model.invalid/v1' },
    async (_url, init) => {
      attempts++;
      const body = JSON.parse(String(init?.body));
      const corrected = body.messages.at(-1).content.includes('0至24');
      return Response.json({
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                decision: 'update',
                previousEventId: previous,
                newFactIndexes: corrected ? [0, 24] : [0, 24, 25],
                reason: '新增进展',
              }),
            },
          },
        ],
      });
    },
  );
  assert.deepEqual(result.value.newFactIndexes, [0, 24]);
  assert.equal(attempts, 2);
});
