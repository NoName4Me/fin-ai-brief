import { budgetLimit } from './editorial-limits.ts';
export function highlightErrors(
  items: { text: string }[],
  config: {
    highlightsEnabled: boolean;
    highlightsDeleted?: boolean;
    highlightsMaxItems: number;
    highlightsBudget: number;
    budgetTolerancePercent?: number;
  },
) {
  const errors: string[] = [];
  if ((!config.highlightsEnabled || config.highlightsDeleted) && items.length)
    errors.push('要览已关闭，不能生成要览条目');
  if (items.length > config.highlightsMaxItems)
    errors.push(`要览最多${config.highlightsMaxItems}条`);
  const limit = budgetLimit(config.highlightsBudget, config.budgetTolerancePercent);
  if (items.reduce((sum, item) => sum + [...item.text].length, 0) > limit)
    errors.push(`要览总字数不能超过${limit}字（含容差）`);
  return errors;
}
