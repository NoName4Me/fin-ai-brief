import { z } from 'zod';
import type { BriefContent } from './types.ts';
export const editFieldSchema = z
  .object({
    kind: z.enum([
      'title',
      'note',
      'highlightsTitle',
      'overview',
      'itemTitle',
      'itemSummary',
      'itemProgress',
      'highlight',
      'rotationName',
      'rotationText',
    ]),
    subIndex: z.number().int().min(0).max(7).optional(),
    index: z.number().int().min(0).max(99).optional(),
    key: z.string().max(100).optional(),
  })
  .strict();
export type EditField = z.infer<typeof editFieldSchema>;
export function fieldValue(content: BriefContent, field: EditField): string {
  switch (field.kind) {
    case 'title':
      return content.title;
    case 'note':
      return content.note ?? '';
    case 'highlightsTitle':
      return content.highlightsTitle ?? '今日要览';
    case 'overview':
      if (field.key !== undefined && Object.hasOwn(content.overview, field.key))
        return content.overview[field.key];
      break;
    case 'itemTitle':
      if (field.index !== undefined && content.items[field.index])
        return content.items[field.index].title;
      break;
    case 'itemSummary':
      if (field.index !== undefined && content.items[field.index])
        return content.items[field.index].summary;
      break;
    case 'itemProgress':
      if (
        field.index !== undefined &&
        field.subIndex !== undefined &&
        content.items[field.index]?.progress?.[field.subIndex]
      )
        return content.items[field.index].progress![field.subIndex].text;
      break;
    case 'highlight':
      if (field.index !== undefined && content.highlights?.[field.index])
        return content.highlights[field.index].text;
      break;
    case 'rotationName':
      if (field.index !== undefined && content.rotations?.[field.index])
        return content.rotations[field.index].displayName ?? content.rotations[field.index].name;
      break;
    case 'rotationText':
      if (field.index !== undefined && content.rotations?.[field.index])
        return content.rotations[field.index].text;
      break;
  }
  throw new Error('编辑字段不存在');
}
export function replaceField(content: BriefContent, field: EditField, text: string): BriefContent {
  fieldValue(content, field);
  const next = structuredClone(content);
  switch (field.kind) {
    case 'title':
      next.title = text;
      break;
    case 'note':
      next.note = text;
      break;
    case 'highlightsTitle':
      next.highlightsTitle = text;
      break;
    case 'overview':
      next.overview[field.key!] = text;
      break;
    case 'itemTitle':
      next.items[field.index!].title = text;
      break;
    case 'itemSummary':
      next.items[field.index!].summary = text;
      break;
    case 'itemProgress':
      next.items[field.index!].progress![field.subIndex!].text = text;
      break;
    case 'highlight':
      next.highlights![field.index!].text = text;
      break;
    case 'rotationName':
      next.rotations![field.index!].displayName = text;
      break;
    case 'rotationText':
      next.rotations![field.index!].text = text;
      break;
  }
  return next;
}
