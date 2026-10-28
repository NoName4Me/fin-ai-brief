export function budgetLimit(budget: number, tolerancePercent = 0) {
  return Math.floor((budget * (100 + tolerancePercent)) / 100);
}

// Lower only as far as needed to reach the configured count; never change saved scores.
export function admissionThreshold(
  standard: number,
  ratings: number[],
  target: number,
  enabled: boolean,
  maxDrop: number,
  minimum = 1,
) {
  if (!enabled || target <= 0 || ratings.filter((r) => r >= standard).length >= target)
    return standard;
  const floor = Math.max(minimum, Math.round((standard - maxDrop) * 100) / 100);
  const eligible = ratings.filter((r) => r >= floor).sort((a, b) => b - a);
  if (!eligible.length) return standard;
  const threshold = eligible[Math.min(target, eligible.length) - 1];
  return Math.max(floor, Math.min(standard, threshold));
}
