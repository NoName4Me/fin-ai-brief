import { taskTypes as baseTypes, stateNames as baseStates } from './task-labels.ts';
export { taskStamp, failureExplanation, stageDescription, stageLabel } from './task-labels.ts';
export const taskTypes = { ...baseTypes, reprocess: '批量重处理' } as const;
export const stateNames: Record<string, string> = {
  ...baseStates,
  generating: '生成日报中',
  completed_with_errors: '完成，有失败项',
};
