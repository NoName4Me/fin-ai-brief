import { defaultTitlePrompt } from './title-writing.ts';
import { z } from 'zod';
import { briefTitleSchema } from './types.ts';

export function dailyTitleRequest(input: unknown, maxLength: number, prompt = defaultTitlePrompt) {
  return {
    system: `你是新闻编辑。根据给定已完成正文拟本期期刊大标题，最多${maxLength}字（含标点和英文字符）。${prompt}只使用提供的材料，不添加外部事实。只输出{title}。`,
    input,
    schema: z.object({ title: briefTitleSchema }).superRefine((v, ctx) => {
      if ([...v.title].length > maxLength)
        ctx.addIssue({ code: 'custom', path: ['title'], message: `标题不得超过${maxLength}字` });
      if (
        /^(?:AI|人工智能)(?:治理|发展|金融|应用|技术|安全|与|及|和|、|\s)+(?:观察|进展|动态|综述)$/.test(
          v.title,
        )
      )
        ctx.addIssue({
          code: 'custom',
          path: ['title'],
          message: '标题过于泛化，请写出本期具体主体及其动作或变化',
        });
    }),
  };
}
