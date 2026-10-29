type Candidate = { rating?: number | null; selected?: boolean; reason?: string };
type Record = {
  status: string;
  section?: string;
  candidate_count: number;
  selected_count: number;
  reason: string;
  details?: Candidate[];
};
export function explainEditionRecord<T extends Record>(record: T, processingFailures?: number): T {
  if (record.status !== 'error' || record.selected_count > 0) return record;
  // Historical failures stored the complete validation error on every section.
  // Recover the affected sections from individual validation messages, never from a shared string match.
  if (record.section) {
    try {
      const issues: unknown = JSON.parse(record.reason);
      if (Array.isArray(issues) && issues.length) {
        const messages = issues.map((issue) =>
          typeof issue?.message === 'string' ? issue.message : '',
        );
        const sections = messages.map(
          (message) => message.match(/^(.+?)超过(?:\d+字上限|字数要求)/)?.[1],
        );
        if (sections.every((name) => !!name)) {
          const own = messages.filter((_, index) => sections[index] === record.section);
          return own.length
            ? { ...record, reason: own.join('；') }
            : {
                ...record,
                status: 'blocked',
                reason: `整期因${[...new Set(sections)].join('、')}栏目处理异常未出刊；本栏目未记录独立异常`,
              };
        }
      }
    } catch {
      /* Non-JSON reasons describe a general generation failure. */
    }
  }
  const details = record.details ?? [];
  if (
    details.length > 0 &&
    details.length === record.candidate_count &&
    details.every((d) => d.selected === false && d.reason === '未达到入选分数')
  )
    return {
      ...record,
      status: 'skipped',
      reason: `候选${record.candidate_count}条均未达到本次日报候选门槛，本期正常留空`,
    };
  if (/采集或处理存在异常，不能判定为正常无内容/.test(record.reason))
    return {
      ...record,
      reason: processingFailures
        ? `本栏目暂无候选，可能因本批次有${processingFailures}条资讯处理失败导致候选材料不完整`
        : '本栏目暂无候选，可能因当次整期采集或处理检查未通过导致候选材料不完整',
    };
  const pendingCause = record.reason.match(/^(.+?)；本栏目暂无候选，缺稿原因待核查$/)?.[1];
  if (pendingCause)
    return {
      ...record,
      reason: `本栏目暂无候选，可能因${pendingCause}导致候选材料不完整`,
    };
  return record;
}
export function fixedSectionOutcome(input: {
  candidates: number;
  qualified: number;
  selected: number;
  unscored: number;
  published: boolean;
  health: { processing_errors: number; source_errors: number; unassessed: number };
}) {
  const { candidates, qualified, selected, unscored, published, health } = input;
  if (selected)
    return {
      status: published ? 'published' : 'ready',
      reason: `候选${candidates}条，${qualified}条达到选题分数，按去重和篇幅采用${selected}条${unscored ? `；${unscored}条缺少当前指标评分` : ''}`,
    };
  if (unscored)
    return {
      status: 'error',
      reason: `本栏目有${unscored}条候选缺少当前启用指标评分，需要重新处理`,
    };
  if (candidates > 0 && !qualified)
    return { status: 'skipped', reason: `候选${candidates}条均未达到日报候选门槛，本期正常留空` };
  if (qualified > 0)
    return { status: 'skipped', reason: `${qualified}条达到选题分数，因整期事件上限或篇幅未采用` };
  const problems = [
    health.processing_errors ? `${health.processing_errors}篇资讯处理未完成或失败` : '',
    health.source_errors ? `${health.source_errors}个启用信源采集异常或未完成首采` : '',
    health.unassessed ? `${health.unassessed}篇资讯缺少评分` : '',
  ].filter(Boolean);
  return problems.length
    ? {
        status: 'error',
        reason: `本栏目暂无候选，可能因本期有${problems.join('、')}导致候选材料不完整`,
      }
    : { status: 'skipped', reason: '本栏目暂无合格候选，本期正常留空' };
}
