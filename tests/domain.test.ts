import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeFor, duePeriods, localDate, preCollectionCutoff } from '../src/server/periods.ts';
import { canonicalUrl, articleInput } from '../src/server/collect.ts';
import { publicAddress } from '../src/server/fetch.ts';
import { requestModel, modelConfig } from '../src/server/model.ts';
import { renderEmail } from '../src/server/mail.ts';
import { z } from 'zod';
import { fixtureContent } from './fixtures.ts';
test('北京时间跨日、自然周和跨年月区间不受机器时区影响', () => {
  assert.equal(localDate(new Date('2026-10-21T18:00:00Z')), '2026-10-22');
  const day = rangeFor('daily', '2026-10-22', '08:00');
  assert.equal(day.start.toISOString(), '2026-10-21T00:00:00.000Z');
  assert.equal(day.end.toISOString(), '2026-10-22T00:00:00.000Z');
  assert.equal(
    rangeFor('weekly', '2026-10-26', '08:00').start.toISOString(),
    '2026-10-19T00:00:00.000Z',
  );
  assert.equal(
    rangeFor('monthly', '2027-01-01', '08:00').start.toISOString(),
    '2026-12-01T00:00:00.000Z',
  );
  assert.throws(() => rangeFor('monthly', '2026-10-22', '08:00'));
  assert.throws(() => rangeFor('weekly', '2026-10-22', '08:00'));
  assert.throws(() => rangeFor('daily', '2026-02-30', '08:00'));
});
test('定时出刊只在北京时间到点后触发对应类型', () => {
  assert.deepEqual(duePeriods(new Date('2026-05-31T23:59:00Z'), '08:00'), []);
  assert.deepEqual(
    duePeriods(new Date('2026-06-01T00:00:00Z'), '08:00').map((x) => x.kind),
    ['daily', 'weekly', 'monthly'],
  );
});
test('出刊前一小时补采，跳过此前一小时已采集的信源，并支持跨午夜', () => {
  const at = (value: string) => new Date(value);
  assert.equal(preCollectionCutoff(at('2026-06-01T22:59:00Z'), '08:00'), null);
  assert.equal(
    preCollectionCutoff(at('2026-06-01T23:00:00Z'), '08:00')?.toISOString(),
    '2026-06-01T22:00:00.000Z',
  );
  assert.equal(
    preCollectionCutoff(at('2026-06-01T23:59:00Z'), '08:00')?.toISOString(),
    '2026-06-01T22:00:00.000Z',
  );
  assert.equal(preCollectionCutoff(at('2026-06-02T00:00:00Z'), '08:00'), null);
  assert.equal(
    preCollectionCutoff(at('2026-06-02T00:30:00Z'), '09:30')?.toISOString(),
    '2026-06-01T23:30:00.000Z',
  );
  assert.equal(
    preCollectionCutoff(at('2026-06-01T15:15:00Z'), '00:15')?.toISOString(),
    '2026-06-01T14:15:00.000Z',
  );
  assert.equal(preCollectionCutoff(at('2026-06-01T15:14:00Z'), '00:15'), null);
});
test('去重剔除跟踪参数，保留影响正文的查询参数', () => {
  assert.equal(
    canonicalUrl('https://example.com/a?id=7&utm_source=x#abc'),
    'https://example.com/a?id=7',
  );
  assert.equal(
    articleInput.safeParse({
      title: 'a',
      url: 'javascript:alert(1)',
      excerpt: 'b',
      sourceName: 'c',
      industryId: 'ai',
      publishedAt: '2026-10-22T08:00:00+08:00',
    }).success,
    false,
  );
  assert.equal(
    articleInput.safeParse({
      title: 'a',
      url: 'https://example.com/a',
      excerpt: 'b',
      sourceName: 'c',
      industryId: 'ai',
      publishedAt: '2026-10-22T08:00:00',
    }).success,
    false,
  );
});
test('采集拒绝本机、私网、链路本地及IPv4映射IPv6地址', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
});
test('按配置调用 OpenAI 兼容接口，校验JSON及截断结果', async () => {
  const config = {
    baseUrl: 'http://127.0.0.1:3425/v1/',
    apiKey: 'different-key',
    model: 'provider/custom-model',
  };
  const schema = z.object({ ok: z.boolean() });
  const response = (finish = 'stop', content = '{"ok":true}') =>
    new Response(
      JSON.stringify({
        choices: [{ finish_reason: finish, message: { content } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    );
  const fake: typeof fetch = async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:3425/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, config.model);
    assert.equal(body.thinking, undefined);
    assert.equal(body.response_format.type, 'json_object');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer different-key');
    return response();
  };
  assert.deepEqual(await requestModel('test', {}, schema, config, fake), {
    value: { ok: true },
    inputTokens: 11,
    outputTokens: 7,
  });
  await assert.rejects(
    () => requestModel('test', {}, schema, config, async () => response('length')),
    /不完整/,
  );
  await assert.rejects(() =>
    requestModel('test', {}, schema, config, async () => response('stop', '{"ok":"wrong"}')),
  );
  let captured = 0;
  await assert.rejects(
    () =>
      requestModel(
        'test',
        {},
        schema,
        config,
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: 'length', message: { content: null } }],
              usage: { prompt_tokens: 15, completion_tokens: 6000 },
            }),
          ),
        12000,
        async (_input, output) => {
          captured = output;
        },
      ),
    /不完整/,
  );
  assert.equal(captured, 6000);
  await assert.rejects(
    () =>
      requestModel(
        'test',
        {},
        schema,
        config,
        async () => new Response('private server error', { status: 429 }),
      ),
    /HTTP 429/,
  );
});
test('结构校验失败时把具体错误反馈给模型，只自动修复一次并累计两次用量', async () => {
  const config = {
    baseUrl: 'http://127.0.0.1:3425/v1',
    apiKey: 'different-key',
    model: 'provider/custom-model',
  };
  const schema = z
    .object({
      assessment: z.record(z.string(), z.object({ score: z.number(), reason: z.string() })),
      scoreReason: z.string(),
    })
    .strict();
  const requests: {
    messages: { role: string; content: string }[];
  }[] = [];
  const captures: number[] = [];
  const fake: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const content =
      requests.length === 1
        ? {
            assessment: {
              relevance: { score: 5, reason: '直接涉及AI' },
              scoreReason: '评分字段嵌套错误',
            },
          }
        : {
            assessment: { relevance: { score: 5, reason: '直接涉及AI' } },
            scoreReason: '评分字段嵌套错误',
          };
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  };
  assert.deepEqual(
    await requestModel('test', {}, schema, config, fake, 12000, async (_input, _output, _, n) => {
      captures.push(n);
    }),
    {
      value: {
        assessment: { relevance: { score: 5, reason: '直接涉及AI' } },
        scoreReason: '评分字段嵌套错误',
      },
      inputTokens: 20,
      outputTokens: 10,
    },
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages.length, 2);
  assert.equal(requests[1].messages.length, 4);
  assert.match(requests[1].messages[3].content, /assessment\.scoreReason/);
  assert.deepEqual(captures, [1, 2]);
});
test('模型配置完全来自环境变量，缺失或不合法时拒绝调用', () => {
  const keys = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'] as const;
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.LLM_BASE_URL = 'http://127.0.0.1:3425/v1/';
    process.env.LLM_API_KEY = 'unit-test-placeholder-key';
    process.env.LLM_MODEL = 'another-provider/model';
    assert.deepEqual(modelConfig(), {
      baseUrl: 'http://127.0.0.1:3425/v1',
      apiKey: 'unit-test-placeholder-key',
      model: 'another-provider/model',
    });
    for (const key of keys) {
      const value = process.env[key];
      delete process.env[key];
      assert.throws(() => modelConfig(), /请在 .env 配置/);
      process.env[key] = value;
    }
    for (const url of [
      'file:///tmp/model',
      'https://user:secret@example.invalid/v1',
      'https://example.invalid/v1?key=secret',
    ]) {
      process.env.LLM_BASE_URL = url;
      assert.throws(() => modelConfig(), /LLM_BASE_URL/);
    }
  } finally {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
});
test('邮件使用同一份内容、独立版式并转义所有正文和链接', () => {
  const content = fixtureContent();
  content.items[0].summary = '<script>alert(1)</script>';
  const html = renderEmail(
    content,
    'https://example.com/brief',
    'https://example.com/unsubscribe?token=a&b=c',
  );
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('token=a&amp;b=c'));
  assert.ok(html.includes(content.items[1].title));
});

test('日报周报按月分组，只有当月展开；月报保留各年份并按年归组', async () => {
  const { groupIssues } = await import('../src/server/brief-presentation.ts');
  const issues = [
    { periodDate: '2025-12-01' },
    { periodDate: '2026-09-21' },
    { periodDate: '2026-10-22' },
    { periodDate: '2026-10-01' },
  ];
  const now = new Date('2026-10-23T00:00:00+08:00');
  for (const kind of ['daily', 'weekly'] as const) {
    const groups = groupIssues(issues, kind, now);
    assert.deepEqual(
      groups.map((g) => [g.label, g.open]),
      [
        ['2026年10月', true],
        ['2026年9月', false],
        ['2025年12月', false],
      ],
    );
    assert.equal(groups[0].items[0].periodDate, '2026-10-22');
  }
  const monthly = groupIssues(issues, 'monthly', now);
  assert.equal(monthly.length, 2);
  assert.equal(monthly[1].label, '2025年');
  assert.equal(monthly[1].open, false);
  assert.equal(monthly[0].label, '2026年');
  assert.ok(monthly[0].items.every((i) => i.periodDate.startsWith('2026')));
  const crossYear = groupIssues(
    [
      { periodDate: '2026-02-01', content: { rangeStart: '2026-01-01T00:00:00Z' } },
      { periodDate: '2026-01-01', content: { rangeStart: '2025-12-01T00:00:00Z' } },
    ],
    'monthly',
    now,
  );
  assert.deepEqual(
    crossYear.map((group) => group.key),
    ['2026', '2025'],
  );
});
test('目录按已出现的栏目去重', async () => {
  const { sectionLinks, weekday } = await import('../src/server/brief-presentation.ts');
  const content = fixtureContent();
  assert.deepEqual(
    sectionLinks(content, {
      id: 'finance',
      sections: ['行业监管', '行业进展', '相关报告', '未出现栏目'],
    }).map((s) => s.name),
    ['行业监管', '行业进展', '相关报告'],
  );
  assert.equal(weekday('2026-10-22'), '周四');
});

test('从视觉稿HTML读取真实选读，保留摘要、重点与日期精度', async () => {
  const { readFile } = await import('node:fs/promises');
  const { readReferenceSnapshot } = await import('../scripts/reference-snapshot.ts');
  const html = await readFile(
    new URL('../docs/visual-reference/index.html', import.meta.url),
    'utf8',
  );
  const snapshot = readReferenceSnapshot(html);
  assert.equal(snapshot.items.length, 8);
  assert.equal(snapshot.items[0].sources[0].publishedAt, '2026-10-22');
  assert.match(snapshot.items[0].sources[0].timeNote ?? '', /未披露时分/);
  assert.ok(snapshot.items[0].emphasis?.includes('会议表态'));
  assert.equal(snapshot.items[4].sources[0].publishedAt, '2026-10-21T19:23:19.000Z');
  assert.equal(snapshot.rangeEnd, '2026-10-22T07:40:00.000Z');
  assert.ok(
    snapshot.items.every(
      (item) => !item.title.includes('演示') && !item.sources[0].url.includes('example.invalid'),
    ),
  );
  assert.throws(
    () => readReferenceSnapshot('<script>throw new Error("不可执行脚本")</script>'),
    /缺少/,
  );
});

test('代理Fake-IP仅在显式允许时接受，仍拒绝回环和内网地址', () => {
  assert.equal(publicAddress('198.18.0.4'), false);
  assert.equal(publicAddress('198.18.0.4', true), true);
  assert.equal(publicAddress('127.0.0.1', true), false);
  assert.equal(publicAddress('192.168.0.1', true), false);
});

test('RSS入口直接使用配置URL，保留其中的token参数', async () => {
  const { sourceRequestUrl } = await import('../src/server/source-access.ts');
  const url = 'https://mcp.applications.jiqizhixin.com/rss?token=test-token';
  assert.equal(sourceRequestUrl(url), url);
  assert.equal(
    sourceRequestUrl('https://example.invalid/rss?token=other'),
    'https://example.invalid/rss?token=other',
  );
});

test('银行保险报公开接口仅在指定HTTPS端点使用POST与站点标识', async () => {
  const { sourceRequestOptions } = await import('../src/server/source-access.ts');
  const plan = sourceRequestOptions('https://rm-api.cfmc.cn/web/home/news');
  assert.equal(plan.method, 'POST');
  assert.equal(plan.headers?.tenantId, '37');
  const channels = JSON.parse(new URLSearchParams(plan.body).get('data')!);
  assert.deepEqual(
    channels.map((x: { channel_id: number }) => x.channel_id),
    [27, 28, 30, 275, 34, 3261],
  );
  assert.deepEqual(sourceRequestOptions('https://example.invalid/web/home/news'), {});
  assert.deepEqual(sourceRequestOptions('http://rm-api.cfmc.cn/web/home/news'), {});
});

test('自动调频有硬边界，失败不立即提频恢复', async () => {
  const { nextInterval } = await import('../src/server/source-rhythm.ts');
  const source = {
    intervalMinutes: 30,
    minIntervalMinutes: 15,
    maxIntervalMinutes: 120,
    autoInterval: true,
    quietRuns: 0,
    failureCount: 0,
    stableRuns: 5,
  };
  assert.equal(nextInterval({ ...source, intervalMinutes: 15 }, { inserted: 10 }).interval, 60);
  assert.equal(
    nextInterval({ ...source, intervalMinutes: 120, quietRuns: 4 }, { inserted: 0 }).interval,
    120,
  );
  assert.equal(nextInterval(source, { failed: true }).interval, 60);
  assert.equal(
    nextInterval({ ...source, intervalMinutes: 60, stableRuns: 0 }, { inserted: 2 }).interval,
    60,
  );
  assert.equal(nextInterval({ ...source, quietRuns: 2 }, { inserted: 0 }).interval, 60);
});
test('日周月按各自时刻出刊，起刊日期以前不安排，补刊先限定期数', async () => {
  const { backfillPeriods } = await import('../src/server/periods.ts');
  const config = {
    dailyTime: '08:00',
    weeklyTime: '10:00',
    monthlyTime: '11:00',
    startDate: '2026-06-01',
  };
  assert.deepEqual(
    duePeriods(new Date('2026-06-01T01:00:00Z'), config).map((p) => p.kind),
    ['daily'],
  );
  assert.deepEqual(
    duePeriods(new Date('2026-06-01T02:00:00Z'), config).map((p) => p.kind),
    ['daily', 'weekly'],
  );
  assert.deepEqual(duePeriods(new Date('2026-05-31T05:00:00Z'), config), []);
  assert.equal(backfillPeriods('2026-06-01', '2026-06-30', 'weekly').length, 5);
  assert.throws(() => backfillPeriods('2025-01-01', '2026-01-01', 'daily'), /最多补刊/);
});

test('自定义周报出刊日用于到期判断、手动区间与补刊', async () => {
  const { backfillPeriods } = await import('../src/server/periods.ts');
  const config = {
    dailyTime: '08:00',
    weeklyTime: '09:00',
    monthlyTime: '10:00',
    startDate: '2026-01-01',
    weeklyDay: 0,
    monthlyDay: 1,
  };
  assert.deepEqual(
    duePeriods(new Date('2026-10-25T00:59:00Z'), config).map((p) => p.kind),
    ['daily'],
  );
  assert.deepEqual(
    duePeriods(new Date('2026-10-25T01:00:00Z'), config).map((p) => p.kind),
    ['daily', 'weekly'],
  );
  assert.deepEqual(
    duePeriods(new Date('2026-10-26T01:00:00Z'), config).map((p) => p.kind),
    ['daily'],
  );
  assert.equal(
    rangeFor('weekly', '2026-10-25', '09:00', config).start.toISOString(),
    '2026-10-18T01:00:00.000Z',
  );
  assert.throws(() => rangeFor('weekly', '2026-10-26', '09:00', config));
  assert.deepEqual(
    backfillPeriods('2026-10-01', '2026-10-31', 'weekly', config).map((p) => p.date),
    ['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25'],
  );
});
test('月报31号在大小月、平闰年和跨年连续覆盖相邻计划刊期', async () => {
  const { backfillPeriods } = await import('../src/server/periods.ts');
  const schedule = { monthlyDay: 31 };
  for (const [date, previous] of [
    ['2026-02-28', '2026-01-31'],
    ['2028-02-29', '2028-01-31'],
    ['2026-03-31', '2026-02-28'],
    ['2026-04-30', '2026-03-31'],
    ['2027-01-31', '2026-12-31'],
  ]) {
    const range = rangeFor('monthly', date, '08:00', schedule);
    assert.equal(range.start.toISOString(), previous + 'T00:00:00.000Z');
    assert.equal(range.end.toISOString(), date + 'T00:00:00.000Z');
    const config = {
      ...schedule,
      weeklyDay: 1,
      dailyTime: '08:00',
      weeklyTime: '08:00',
      monthlyTime: '08:00',
      startDate: '2020-01-01',
    };
    assert.ok(duePeriods(range.end, config).some((p) => p.kind === 'monthly'));
    assert.ok(
      !duePeriods(new Date(range.end.getTime() - 60000), config).some((p) => p.kind === 'monthly'),
    );
  }
  assert.deepEqual(
    backfillPeriods('2026-01-01', '2026-04-30', 'monthly', schedule).map((p) => p.date),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'],
  );
  assert.throws(() => rangeFor('monthly', '2026-03-30', '08:00', schedule));
});

test('周报刊头按ISO周编号展示完整周日期，月报大数字为所属月份', async () => {
  const { editionCalendar } = await import('../src/server/brief-presentation.ts');
  const content = fixtureContent();
  content.rangeStart = '2026-10-19T00:00:00.000Z';
  content.rangeEnd = '2026-10-26T00:00:00.000Z';
  assert.deepEqual(editionCalendar('weekly', '2026-10-26', content), {
    top: '2026年10月',
    number: '43',
    detail: '10.19-10.25',
    weekYear: 2026,
  });
  content.rangeStart = '2020-12-28T00:00:00.000Z';
  content.rangeEnd = '2021-01-04T00:00:00.000Z';
  assert.equal(editionCalendar('weekly', '2021-01-04', content).number, '53');
  assert.equal(editionCalendar('weekly', '2021-01-04', content).weekYear, 2020);
  content.rangeStart = '2026-10-01T00:00:00.000Z';
  content.rangeEnd = '2026-11-01T00:00:00.000Z';
  const monthly = editionCalendar('monthly', '2026-11-01', content);
  assert.equal(monthly.top, '2026年');
  assert.equal(monthly.number, '10');
});
test('板块分类按配置聚合，未配置分类补在末尾，分类内保持原顺序', async () => {
  const { sectionGroups } = await import('../src/server/brief-presentation.ts');
  const items = fixtureContent().items.slice(0, 4);
  items[0].section = '行业进展';
  items[1].section = '行业监管';
  items[2].section = '行业进展';
  items[3].section = '新分类';
  const groups = sectionGroups(items, ['行业监管', '行业进展', '相关报告']);
  assert.deepEqual(
    groups.map((g) => g.name),
    ['行业监管', '行业进展', '新分类'],
  );
  assert.deepEqual(
    groups[1].items.map((item) => item.eventId),
    [items[0].eventId, items[2].eventId],
  );
});
