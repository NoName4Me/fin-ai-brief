import { z } from 'zod';

export const rotationChartSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    metric: z.string().trim().min(1).max(60),
    unit: z.string().trim().min(1).max(20),
    period: z.string().trim().min(1).max(60),
    points: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(40),
          value: z.number().finite().min(0).max(1e15),
        }),
      )
      .min(2)
      .max(6),
  })
  .superRefine((chart, ctx) => {
    if (new Set(chart.points.map((point) => point.label)).size !== chart.points.length)
      ctx.addIssue({ code: 'custom', message: '图表标签不能重复' });
  });
export type RotationChart = z.infer<typeof rotationChartSchema>;
export const chartNumber = (value: number) =>
  value.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
