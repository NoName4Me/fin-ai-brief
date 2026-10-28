export const stageNames: Record<string, string> = {
  task: '整次处理',
  retry: '自动重试',
  validate: '材料校验与URL去重',
  recall: '候选事件召回',
  analyze: '模型分析',
  review: '疑难归组与事实复核',
  save: '保存事件与新增事实',
  edition: '栏目选题与出刊记录',
};
export const stageDescriptions: Record<string, string> = {
  task: '整次处理的外层执行记录',
  retry: '队列自动重新执行本次任务，状态表示这次重试的整体结果',
  validate: '检查标题、摘要和来源材料',
  recall: '召回最近14天的候选事件',
  analyze: '相关性判断、评分、事实提取、标题摘要与事件归组',
  review: '对疑难归组和事实边界进行独立复核',
  save: '写入事件、新增事实和资讯处理结果',
  edition: '栏目选题、候选评分与出刊结果',
};
export function stageLabel(stage: string, queue: string) {
  if (stage === 'task')
    return queue === 'collect' ? '采集执行' : queue === 'generate' ? '出刊执行' : '处理执行';
  return stageNames[stage] ?? stage;
}
export function stageDescription(stage: string, queue: string) {
  if (stage === 'task')
    return queue === 'collect'
      ? '执行整次信源采集'
      : queue === 'generate'
        ? '执行整次出刊任务'
        : '执行整次资讯处理';
  return stageDescriptions[stage] ?? '';
}
export const stateNames: Record<string, string> = {
  started: '请求已发送',
  running: '执行中',
  active: '执行中',
  created: '排队中',
  completed: '成功',
  succeeded: '成功',
  failed: '失败',
  waiting: '等待额度',
  waiting_budget: '等待额度',
  waiting_articles: '等待资讯处理',
  skipped: '已续处理／跳过',
  pending: '待处理',
  processed: '已归组',
  ignored: '未入选',
  retry: '等待重试',
  cancelled: '已取消',
};
export const taskTypes = { collect: '采集', generate: '出刊', process: '资讯' } as const;

export function failureExplanation(error: string | null | undefined) {
  if (!error) return '';
  const detail = error.replace(/^[^：]{1,30}失败：/, '');
  if (/job timed out/i.test(detail))
    return '队列等待 15 分钟仍未收到任务结束信号，已判定超时。';
  if (/aborted due to timeout|timed?\s*out|timeout/i.test(detail))
    return '模型请求等待 180 秒后仍未返回，被系统中止';
  if (/HTTP\s+429/i.test(detail)) return '模型服务返回限流，稍后自动重试。';
  if (/HTTP\s+5\d\d/i.test(detail)) return '模型服务返回服务端错误。';
  if (/等待共用模型请求超时/i.test(detail)) return '相同输入的模型请求等待超时';
  if (/模型事实依据不在来源摘要中/.test(detail))
    return '模型给出的事实摘录无法在来源摘要中逐字匹配。';
  if (/模型返回了无效事件引用/.test(detail)) return '模型引用了候选列表之外的已有事件。';
  if (/模型返回了未配置栏目/.test(detail)) return '模型返回的栏目不在该信源允许的范围内。';
  if (/达到上限/.test(detail)) return '模型输出达到 token 上限，内容不完整。';
  return '';
}

export function taskStamp(value: Date | string | null) {
  if (!value) return '未开始';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(value))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
