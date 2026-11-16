import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanSourceText,
  prepareSourceText,
  sourcePassages,
  sourceFactSchema,
} from '../src/server/source-evidence.ts';

test('原文切分保留文字与标点，长句和Unicode字符不丢失', () => {
  const excerpt = '地平线的下一代旗舰征程7系列，也卡在2027。\n J7P采用新架构。' + '😀'.repeat(1200);
  const passages = sourcePassages(excerpt);
  assert.equal(passages.map((p) => p.text).join(''), excerpt);
  assert.ok(passages.every((p) => Array.from(p.text).length <= 1000));
});

test('依据从原文提取，忽略模型加工的摘录，拒绝未知或重复编号', () => {
  const excerpt = '地平线的下一代旗舰征程7系列，也卡在2027。';
  const schema = sourceFactSchema(sourcePassages(excerpt), excerpt);
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
  const fact = sourceFactSchema(passages, excerpt).parse({
    statement: '企业公布规划但进度待验证',
    evidenceIds: ['S3', 'S1'],
    status: 'planned',
  });
  assert.equal(fact.evidence, excerpt);
});

test('模型输入清理页脚、推广与精确重复句，保留事实、数字和限定语', () => {
  const fact = '企业计划2027年投入30亿元，具体进度仍需监管批准。';
  const excerpt = [
    fact,
    fact,
    '责任编辑：张三',
    '免责声明：本文不构成投资建议。',
    '扫描二维码关注公众号，获取更多内容。',
    '相关阅读：另一篇文章',
  ].join('\n');
  assert.equal(cleanSourceText(excerpt), fact);
});

test('清理结果为空时回退原文，不对普通短句做模板误删', () => {
  assert.equal(cleanSourceText('风险提升，企业下调全年指引。'), '风险提升，企业下调全年指引。');
  assert.equal(cleanSourceText('免责声明：本文不构成投资建议。'), '免责声明：本文不构成投资建议。');
});

test('精确去重保留小数、版本号和正文中的未经授权事实', () => {
  const excerpt = [
    '企业预计未来三年将投入1.5亿元用于人工智能平台建设。',
    '企业预计未来三年将投入15亿元用于人工智能平台建设。',
    '本文提及的产品未经授权发布，厂商表示正在调查。',
    '点击下载模型权重后可在本地部署，企业称推理成本下降50%。',
    '本文据匿名消息编写，仅供参考，企业可能于2027年融资30亿元。',
  ].join('\n');
  assert.equal(cleanSourceText(excerpt), excerpt);
});

test('清洁后的事实依据仍按原始正文偏移提取完整连续跨度', () => {
  const excerpt = [
    '企业发布人工智能模型，计划明年开放。',
    '责任编辑：张三',
    '企业称准确率达到90%，尚待第三方验证。',
  ].join('\n');
  const prepared = prepareSourceText(excerpt);
  const passages = sourcePassages(excerpt, prepared.ranges);
  assert.deepEqual(
    passages.map((passage) => passage.text),
    ['企业发布人工智能模型，计划明年开放。', '企业称准确率达到90%，尚待第三方验证。'],
  );
  const fact = sourceFactSchema(passages, excerpt).parse({
    statement: '企业发布模型并披露准确率',
    evidenceIds: ['S1', 'S2'],
    status: 'announced',
  });
  assert.equal(fact.evidence, excerpt);
});
