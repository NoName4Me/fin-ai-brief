import type { BriefContent } from '../server/types.ts';

// 2026-10-23手工核实的公开资料；仅供版式预览，不进入采集、发布或投递流程。
export const sampleIndustries = [
  { id: 'finance', name: '金融', description: '政策与宏观', sections: ['货币政策', '经济数据'] },
  { id: 'ai', name: 'AI', description: '模型与应用', sections: ['模型进展', '平台能力'] },
];
const records = [
  [
    'finance',
    '货币政策',
    '美联储加息25个基点，目标区间升至3.75%—4.00%',
    '美联储9月16日以12比0的投票结果决定，将联邦基金利率目标区间上调25个基点至3.75%—4.00%。声明认为经济活动稳健扩张、通胀仍高，并表示将实现价格稳定，同时继续维持银行体系充裕准备金。',
    '美联储',
    '2026-09-16',
    'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm',
  ],
  [
    'finance',
    '货币政策',
    '欧洲央行上调三项关键利率，存款利率升至2.50%',
    '欧洲央行9月10日宣布将三项关键利率上调25个基点，存款便利、主要再融资和边际贷款便利利率分别升至2.50%、2.65%和2.90%，9月16日起生效。管理委员会表示，将依数据逐次会议决定政策，不预先承诺特定利率路径。',
    '欧洲央行',
    '2026-09-10',
    'https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.mp260910~314e508016.en.html',
  ],
  [
    'finance',
    '经济数据',
    '8月规上工业增加值同比增长5.2%',
    '国家统计局9月15日发布8月国民经济运行情况：规模以上工业增加值同比增长5.2%，高技术制造业增加值增长16.7%；货物进出口总额同比增长19.8%。8月城镇调查失业率为5.3%。',
    '国家统计局',
    '2026-09-15',
    'https://www.stats.gov.cn/sj/zxfb/202609/t20260915_1965307.html',
  ],
  [
    'ai',
    '模型进展',
    'DeepSeek发布V4.1 Flash，提供原生多模态能力',
    'DeepSeek在9月10日更新日志中发布V4.1 Flash，支持原生多模态视觉理解，通过deepseek-flash调用。官方同时披露了模型迁移与旧模型名兼容安排。',
    'DeepSeek',
    '2026-09-10',
    'https://api-docs.deepseek.com/updates/#date-2026-09-10',
  ],
  [
    'ai',
    '模型进展',
    'Claude Opus 5.5发布，面向复杂任务与持续工作',
    'Anthropic于9月22日发布Claude Opus 5.5，定位于需要持续判断的复杂任务。公司称，其在多数工作中的表现接近Claude Fable 5.1，运行成本较Opus 5降低40%。',
    'Anthropic',
    '2026-09-22',
    'https://www.anthropic.com/claude-opus-5-5',
  ],
  [
    'ai',
    '模型进展',
    'Claude Sonnet 5.5发布，强调日常任务效率',
    'Anthropic于9月28日发布Claude Sonnet 5.5，面向范围明确的日常工作、软件修复及文档制作。公司称输出速度较Sonnet 5提升超过30%，多数工作的每项任务成本最多降低30%；输入、输出token标价仍分别为每百万2美元和10美元。',
    'Anthropic',
    '2026-09-28',
    'https://www.anthropic.com/claude-sonnet-5-5',
  ],
  [
    'finance',
    '经济数据',
    '9月CPI同比上涨0.9%，核心CPI上涨1.0%',
    '国家统计局10月14日发布9月价格数据：CPI同比上涨0.9%，涨幅较8月扩大0.1个百分点；环比上涨0.2%。扣除食品和能源的核心CPI同比上涨1.0%，与上月相同。',
    '国家统计局',
    '2026-10-14',
    'https://www.stats.gov.cn/sj/zxfbhjd/202610/t20261014_1965477.html',
  ],
  [
    'finance',
    '经济数据',
    '9月PPI同比上涨5.0%，环比涨幅扩大',
    '国家统计局10月14日解读显示，9月工业生产者出厂价格指数（PPI）同比上涨5.0%，涨幅较上月扩大1.2个百分点；环比上涨1.2%，涨幅扩大0.8个百分点。',
    '国家统计局',
    '2026-10-14',
    'https://www.stats.gov.cn/sj/zxfbhjd/202610/t20261014_1965475.html',
  ],
  [
    'ai',
    '模型进展',
    'Meta推出Muse Wonder系列，瞄准个人与专业智能体',
    'Meta于10月12日介绍Muse Wonder与Muse Wonder Full，强调个人和专业智能体任务，覆盖保险理赔、租约理解、财务信息及编程等场景。Muse Wonder通过Meta Model API和Muse Code提供，Full版本面向Muse Code订阅者。',
    'Meta',
    '2026-10-12',
    'https://about.fb.com/news/2026/10/introducing-muse-wonder-models/',
  ],
  [
    'ai',
    '平台能力',
    'DeepSeek开放自研搜索API，并更新Flash模型',
    'DeepSeek于10月17日宣布开放自研搜索API，提供搜索与网页获取能力；同期将V4.1 Flash更新至DeepSeek-V4.1-Flash-1017。官方称API调用方式与价格不变，继续使用deepseek-flash即可访问新版本。',
    'DeepSeek',
    '2026-10-17',
    'https://api-docs.deepseek.com/updates/#date-2026-10-17',
  ],
] as const;
const items: BriefContent['items'] = records.map(
  ([industryId, section, title, summary, name, publishedAt, url], index) => ({
    eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    industryId,
    section,
    title,
    summary,
    sources: [{ title, name, publishedAt, url }],
  }),
);
export const reportSamples: Record<'weekly' | 'monthly', BriefContent> = {
  weekly: {
    title: '价格数据更新，智能体与搜索能力继续推进',
    rangeStart: '2026-10-11T16:00:00.000Z',
    rangeEnd: '2026-10-18T15:59:59.999Z',
    overview: {
      finance: '本周公布的9月CPI与PPI同比涨幅均扩大，核心CPI增速保持不变。',
      ai: 'Meta发布面向智能体的新模型，DeepSeek开放搜索API并迭代Flash。',
    },
    items: items.slice(6),
  },
  monthly: {
    title: '利率上调与模型效率升级并行',
    rangeStart: '2026-08-31T16:00:00.000Z',
    rangeEnd: '2026-09-30T15:59:59.999Z',
    overview: {
      finance:
        '美联储与欧洲央行均于9月加息25个基点。国内公布8月经济数据，规上工业增加值同比增长5.2%。',
      ai: 'DeepSeek推进原生多模态，Anthropic接连更新Opus与Sonnet。复杂任务能力与日常任务效率成为本月两条观察线。',
    },
    items: items.slice(0, 6),
  },
};
export const sampleMetrics = {
  weekly: [
    {
      value: '0.9',
      unit: '%',
      label: '9月CPI同比',
      context: '10月14日公布 · 较上月 +0.1个百分点',
      item: items[6],
    },
    {
      value: '5.0',
      unit: '%',
      label: '9月PPI同比',
      context: '10月14日公布 · 较上月 +1.2个百分点',
      item: items[7],
    },
    {
      value: '2',
      unit: '款',
      label: 'Muse Wonder系列模型',
      context: '10月12日 · Meta公布',
      item: items[8],
    },
  ],
  monthly: [
    {
      value: '3.75–4.00',
      unit: '%',
      label: '美联储目标利率区间',
      context: '9月16日 · 上调25个基点',
      item: items[0],
    },
    {
      value: '2.50',
      unit: '%',
      label: '欧洲央行存款便利利率',
      context: '9月10日宣布 · 9月16日生效',
      item: items[1],
    },
    {
      value: '30',
      unit: '%+',
      label: 'Sonnet 5.5输出速度提升',
      context: '对比Sonnet 5 · 厂商测试',
      item: items[5],
    },
  ],
};
export const sampleQuestions = {
  weekly: [
    { title: '价格结构', text: '继续跟踪能源、食品与核心价格变化，区分消费端和生产端的传导。' },
    { title: '检索质量', text: '以金融问题验证搜索来源质量、时效性，以及答案能否准确引用证据。' },
    { title: '任务边界', text: '在理赔、财务等场景检验智能体的权限控制、人工确认与执行记录。' },
  ],
  monthly: [
    { title: '政策后续', text: '跟踪美欧后续通胀数据与议息声明，观察本轮加息后的政策节奏。' },
    { title: '效率验证', text: '对相同金融任务比较新旧模型的准确率、完成时长与单次任务成本。' },
    { title: '能力落地', text: '结合财报、图表与扫描件，测试原生多模态在真实材料中的可用性。' },
  ],
};
