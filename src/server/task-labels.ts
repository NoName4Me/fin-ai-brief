export const stageNames: Record<string, string> = {
  task: '任务执行',
  validate: '材料校验与URL去重',
  recall: '候选事件召回',
  analyze: '相关性、评分、事实、标题摘要及归组（共用一次调用）',
  review: '疑难归组与事实复核',
  save: '保存事件与新增事实',
};
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
