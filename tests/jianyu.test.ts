import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jianyuItems,
  jianyuPublishTime,
  jianyuRequestOptions,
  jianyuSearchUrl,
} from '../src/server/jianyu.ts';
import { structuredKind } from '../src/server/structured-sources.ts';

test('剑鱼采集窗口按下一发刊时点的前一日08:00至当日08:00计算', () => {
  const expected = '1793145600-1793231999';
  assert.equal(jianyuPublishTime(new Date('2026-10-28T14:00:00+08:00'), '08:00'), expected);
  assert.equal(jianyuPublishTime(new Date('2026-10-29T03:00:00+08:00'), '08:00'), expected);
  assert.equal(
    jianyuPublishTime(new Date('2026-10-28T07:59:59+08:00'), '08:00'),
    '1793059200-1793145599',
  );
});

test('剑鱼搜索入口使用动态时间窗和详情页链接', () => {
  assert.equal(structuredKind(jianyuSearchUrl), 'jianyu-search');
  const options = jianyuRequestOptions(new Date('2026-10-28T14:00:00+08:00'), '08:00');
  assert.equal(options.method, 'POST');
  assert.equal(JSON.parse(options.body).publishTime, '1793145600-1793231999');
  const items = jianyuItems(
    JSON.stringify({
      error_code: 0,
      data: {
        list: [
          {
            id: 'sample-id',
            title: ' 大模型采购公告 ',
            detail: ' 项目采购智能体平台。 ',
            publishTime: 1793165190,
          },
        ],
      },
    }),
  );
  assert.deepEqual(items, [
    {
      title: '大模型采购公告',
      url: 'https://www.jianyu360.cn/nologin/content/sample-id.html',
      excerpt: '项目采购智能体平台。',
      publishedAt: '2026-10-28T05:26:30.000Z',
      publishedPrecision: 'time',
    },
  ]);
});
