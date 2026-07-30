export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const roundMoney = (value: number): number =>
  Math.round(value / 5) * 5;

export const weightedMedian = (
  values: Array<{ value: number; weight: number }>
): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  let running = 0;
  for (const item of sorted) {
    running += item.weight;
    if (running >= total / 2) return item.value;
  }
  return sorted[sorted.length - 1].value;
};

export const severityPenalty = {
  low: 1.5,
  medium: 4,
  high: 8,
  critical: 15,
} as const;
