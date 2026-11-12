import { z } from 'zod';
import { budgetLimit } from './editorial-limits.ts';
import { rotationChartSchema } from './rotation-chart.ts';
import type { WeeklyMaterials } from './weekly-review.ts';

const dataColumnNames = ['数据一图／观点摘编', '数据一图', '一周数据', '观点摘编'];
const supportSchema = z.strictObject({
  eventRef: z.string(),
  factRef: z.string(),
  speaker: z.string().trim().min(1).max(80).optional(),
});
const textSchema = z.strictObject({
  text: z.string().trim().min(1),
  eventRefs: z.array(z.string()),
});
const curatedSchema = textSchema.extend({
  kind: z.enum(['data', 'viewpoints']),
  basis: z.array(supportSchema).min(1).max(8),
  chart: rotationChartSchema
    .safeExtend({
      points: z
        .array(
          z.strictObject({
            label: z.string().trim().min(1).max(40),
            value: z.number().finite().min(0).max(1e15),
            eventRef: z.string(),
            factRef: z.string(),
          }),
        )
        .min(2)
        .max(6),
    })
    .nullable(),
});
const modeRules = `
本栏目必须二选一，不混写泛泛的趋势综述。kind=data显示“数据一图”，kind=viewpoints显示“观点摘编”。
先依据材料选择内容：有明确来源、统计期间、单位、适用范围的数据，围绕一个主题交代关键数值及其含义，选data。各数字须真实可核对，不能用无关领域的数字拼出“共同趋势”。
有归属明确的具名机构或人士的判断、主张或分歧，选viewpoints。必须写清谁在什么语境下提出什么观点，保留不确定性，不把编辑自己的综合结论冒充来源观点。basis每项给出eventRef、factRef；viewpoints还必须给出材料中明确出现的speaker。
图表可选，data也可以只写文字。只有至少2个同指标、同单位、口径与统计范围可比较的数值才提供chart，否则chart=null；不能为了出图拼数或改选观点。图表使用从0起点的横向柱形图，不支持负值、混合单位或双轴。chart包含title、metric、unit、period、points；每点给出label、value、eventRef、factRef。value必须逐字对应证据中的数值，不自行计算比例、补值、换算单位或把计划当作实际。chart标题和期间不能虚构。viewpoints的chart必须为null。
两种内容都缺乏可靠材料时observation=null。正文只写读者需要的内容，不输出E/F内部编号；来源由系统另行展示。`;
function normalized(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s,，]/g, '');
}
function hasValue(text: string, value: number) {
  return (normalized(text).match(/-?\d+(?:\.\d+)?/g) ?? []).some(
    (token) => Number(token) === value,
  );
}

export function dailyRotationRequest(
  date: string,
  rule: {
    id?: string;
    aliases?: string[];
    name: string;
    description: string;
    keywords: string;
    budget: number;
    minItems: number;
    maxItems: number;
  },
  events: WeeklyMaterials['inputEvents'],
  editorialPrompt: string,
  tolerancePercent: number,
  sourceNames: Record<string, string> = {},
) {
  const identities = [rule.id, rule.name, ...(rule.aliases ?? [])];
  const weekly = identities.includes('一周观察');
  const caseStudy = identities.includes('他山之石');
  const curated = identities.some((name) => !!name && dataColumnNames.includes(name));
  const references = new Map(
    events.map((event, index) => [`E${String(index + 1).padStart(2, '0')}`, event.id]),
  );
  const evidence = new Map<string, { statement: string; evidence: string }>();
  const refs = [...references.keys()];
  events.forEach((event, index) => {
    event.developments
      .flatMap((development) => development.facts)
      .forEach((fact, factIndex) => evidence.set(`${refs[index]}:F${factIndex + 1}`, fact));
  });
  const allowed = refs.join('、');
  const example = JSON.stringify({
    observation: {
      text: '综合正文',
      eventRefs: refs.slice(0, rule.minItems),
      ...(curated
        ? {
            kind: 'data',
            basis: [{ eventRef: refs[0], factRef: 'F1' }],
            chart: null,
          }
        : {}),
    },
  });
  const limit = budgetLimit(rule.budget, tolerancePercent);
  const schema = z
    .strictObject({
      observation: (curated ? curatedSchema : textSchema).nullable(),
    })
    .superRefine(({ observation }, ctx) => {
      if (!observation) return;
      const { text, eventRefs } = observation;
      const fail = (path: (string | number)[], message: string) =>
        ctx.addIssue({ code: 'custom', path: ['observation', ...path], message });
      if ([...text].length > limit)
        fail(
          ['text'],
          `正文当前${[...text].length}字，超过上限${limit}字，请压缩至预算${rule.budget}字以内`,
        );
      if (eventRefs.length < rule.minItems || eventRefs.length > rule.maxItems)
        fail(
          ['eventRefs'],
          `当前引用${eventRefs.length}个事件，必须引用${rule.minItems}至${rule.maxItems}个不同事件`,
        );
      eventRefs.forEach((ref, index) => {
        if (!references.has(ref))
          fail(
            ['eventRefs', index],
            `无效事件编号${ref}；只能原样选用：${allowed}。不得使用来源文章或事件进展ID`,
          );
        if (eventRefs.indexOf(ref) !== index)
          fail(['eventRefs', index], `事件编号${ref}重复，每个事件只能引用一次`);
      });
      if (/\bE\d{2}\b|\bF\d+\b/.test(text))
        fail(['text'], '正文不能出现内部E/F编号，来源由系统展示');
      if (!curated) return;
      const detail = curatedSchema.safeParse(observation);
      if (!detail.success) return;
      const detailed = detail.data;
      const factFor = (eventRef: string, factRef: string, path: (string | number)[]) => {
        const fact = evidence.get(`${eventRef}:${factRef}`);
        if (!eventRefs.includes(eventRef) || !fact)
          fail(path, '依据必须引用本期所选事件的有效F事实编号');
        return fact;
      };
      detailed.basis.forEach((basis, index) => {
        const fact = factFor(basis.eventRef, basis.factRef, ['basis', index]);
        if (!fact) return;
        if (detailed.kind === 'data' && !/\d/.test(normalized(fact.statement)))
          fail(['basis', index], '数据类依据必须包含可核对数值');
        if (
          detailed.kind === 'viewpoints' &&
          (!basis.speaker ||
            !normalized(fact.statement + fact.evidence).includes(normalized(basis.speaker)) ||
            !normalized(text).includes(normalized(basis.speaker)))
        )
          fail(
            ['basis', index, 'speaker'],
            '观点必须归属于所引事实或原文中明确出现的具名人士或机构',
          );
      });
      if (detailed.kind === 'viewpoints' && detailed.chart)
        fail(['chart'], '观点摘编不输出数据图表');
      detailed.chart?.points.forEach((point, index) => {
        const fact = factFor(point.eventRef, point.factRef, ['chart', 'points', index]);
        if (fact && !hasValue(fact.statement + fact.evidence, point.value))
          fail(
            ['chart', 'points', index, 'value'],
            '图表数值必须在所引事实或原文中出现，不自行换算或推算',
          );
      });
      if (
        detailed.chart &&
        new Set(detailed.chart.points.map((point) => point.label)).size !==
          detailed.chart.points.length
      )
        fail(['chart', 'points'], '图表标签不能重复');
    });
  return {
    system: `你是数智参阅编辑。${editorialPrompt}只生成当前一个轮动栏目的综合正文，不能将各事件拆成多个栏目。输出且仅输出${example}；资料不足时输出{"observation":null}。不输出栏目名称、标题、rotations或eventIds。eventRefs必须原样复制events.ref中的编号，引用${rule.minItems}至${rule.maxItems}个不同事件，不能使用内部ID或自编编号。遵守栏目description、keywords和budget，所有事实、机构、数字和案例必须来自所引用事件。developments为本期进展，background仅供背景；保留事实状态、归属和不确定性，不能把观察或采集时点当成发布时间。正文为纯文本。所有轮动正文都不得出现E01、E26、F1等内部引用标记，不要加括号编号；系统会单独提供来源链接。${weekly ? '一周观察须回顾上周3至5件不同的关键事件，并据此写出一段克制的趋势判断；先交代关键事实，再说明共同变化及其边界，不逐条堆新闻，不把不同口径数字强行相加或由相关性推断因果。' : ''}${caseStudy ? '他山之石只选择一家同业或一家厂商，围绕一个具体问题拆解其打法：解决什么问题、采取什么做法、有什么证据、需要哪些条件及可借鉴点。其他机构只作必要背景；不得平行拼接多家新闻，不虚构实施成效或我司需求。材料不足以拆解一家时返回observation:null。' : ''}${curated ? modeRules : ''}`,
    input: {
      date,
      column: {
        name: rule.name,
        description: rule.description,
        keywords: rule.keywords,
        budget: rule.budget,
        minItems: rule.minItems,
        maxItems: rule.maxItems,
      },
      events: events.map((event, index) => {
        let factIndex = 0;
        return {
          ref: refs[index],
          section: event.section,
          developments: event.developments.map(({ reportedAt, facts }) => ({
            reportedAt,
            facts: curated ? facts.map((fact) => ({ ...fact, ref: `F${++factIndex}` })) : facts,
          })),
          background: event.background,
          sources: event.sources.map(
            ({ id, title, publishedAt, observedAt, publishedPrecision }) => ({
              name: sourceNames[id],
              title,
              publishedAt,
              observedAt,
              publishedPrecision,
            }),
          ),
        };
      }),
    },
    schema,
    resolve: ({ observation }: z.infer<typeof schema>) => {
      if (!observation) return null;
      const selected = curated ? curatedSchema.parse(observation) : undefined;
      return {
        name: rule.name,
        ...(selected
          ? {
              displayName: selected.kind === 'data' ? ('数据一图' as const) : ('观点摘编' as const),
            }
          : {}),
        ...(selected?.chart
          ? {
              chart: rotationChartSchema.parse(selected.chart),
            }
          : {}),
        text: observation.text,
        eventIds: observation.eventRefs.map((ref) => references.get(ref)!),
      };
    },
  };
}
