import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourcePassages, sourceFactSchema } from '../src/server/source-evidence.ts';

test('原文切分保留文字与标点，长句和Unicode字符不丢失', () => {
  const excerpt = '地平线的下一代旗舰征程7系列，也卡在2027。\n J7P采用新架构。' + '😀'.repeat(1200);
  const passages = sourcePassages(excerpt);
  assert.equal(passages.map((p) => p.text).join(''), excerpt);
  assert.ok(passages.every((p) => Array.from(p.text).length <= 1000));
});

test('依据从原文提取，忽略模型加工的摘录，拒绝未知或重复编号', () => {
  const excerpt = '地平线的下一代旗舰征程7系列，也卡在2027。';
  const schema = sourceFactSchema(sourcePassages(excerpt));
  const fact = {
    statement: '地平线规划2027年推出征程7系列',
    evidenceIds: ['S1'],
    status: 'planned',
    evidence: excerpt.replace('2027', '2027年'),
  };
  assert.equal(schema.parse(fact).evidence, excerpt);
  assert.equal(schema.safeParse({ ...fact, evidenceIds: ['S999'] }).success, false);
  assert.equal(schema.safeParse({ ...fact, evidenceIds: ['S1', 'S1'] }).success, false);
  assert.equal(schema.safeParse({ ...fact, evidenceIds: [] }).success, false);
});

test('跨句引用保持完整原文跨度，顺序不同仍提取同一段原文', () => {
  const excerpt = '企业公布规划。预计明年推出。实际进度待验证。';
  const passages = sourcePassages(excerpt);
  const fact = sourceFactSchema(passages).parse({
    statement: '企业公布规划但进度待验证',
    evidenceIds: ['S3', 'S1'],
    status: 'planned',
  });
  assert.equal(fact.evidence, excerpt);
});
