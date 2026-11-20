import { taskTypes as baseTypes, stateNames as baseStates } from './task-labels.ts';
export {
  taskStamp,
  taskStartStamp,
  failureExplanation,
  stageDescription,
  stageLabel,
} from './task-labels.ts';
export const taskTypes = { ...baseTypes, reprocess: '批量重处理' } as const;
export const stateNames: Record<string, string> = {
  ...baseStates,
  generating: '生成日报中',
  completed_with_errors: '完成，有失败项',
};

export const taskStatusGroups = [
  {
    value: 'queued',
    label: '排队',
    states: ['created', 'retry', 'waiting_articles', 'waiting_budget', 'waiting_model_window'],
  },
  { value: 'active', label: '处理中', states: ['active', 'generating'] },
  { value: 'succeeded', label: '成功', states: ['succeeded'] },
  { value: 'failed', label: '失败', states: ['failed', 'completed_with_errors'] },
  { value: 'cancelled', label: '已取消', states: ['cancelled'] },
] as const;

export function taskStatusGroup(state: string) {
  return taskStatusGroups.find(
    (group) => group.value === state || group.states.some((member) => member === state),
  );
}
