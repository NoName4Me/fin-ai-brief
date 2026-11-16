import { z } from 'zod';

const boilerplatePatterns = [
  /^(?:责任编辑|责编|校对|审核|排版|监制)\s*[:：].{1,100}$/u,
  /^(?:免责声明|版权声明|特别声明)\s*[:：].*(?:不构成(?:任何)?投资建议|仅供参考|版权归.{0,80}所有|未经授权(?:不得)?转载|禁止转载).*$/u,
  /^(?:未经授权|未经许可|严禁转载|禁止转载)[，,\s]*(?:不得|禁止)?(?:转载|复制|摘编).{0,80}$/u,
  /^(?:点击|长按)\s*(?:阅读原文|下载APP|打开APP|关注公众号)\s*[。.!！]?$/iu,
  /^(?:扫码|扫描二维码)\s*关注公众号[，,]?\s*获取更多内容\s*[。.!！]?$/u,
  /^(?:关注|订阅)(?:公众号|微信公众号|微信号)(?:获取更多内容)?\s*[。.!！]?$/u,
  /^(?:更多精彩|相关阅读|延伸阅读|热门推荐|上一篇|下一篇)\s*[:：].{0,160}$/u,
];

function isBoilerplateLine(line: string) {
  const text = line.trim();
  return text.length <= 240 && boilerplatePatterns.some((pattern) => pattern.test(text));
}

function normalizedSentence(text: string) {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

type SourceRange = { text: string; start: number; end: number };
export type PreparedSourceText = { text: string; ranges: SourceRange[] };

function rangesForText(text: string, offset = 0) {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'sentence' });
  return [...segmenter.segment(text)]
    .map(({ segment, index }) => ({
      text: segment,
      start: offset + index,
      end: offset + index + segment.length,
    }))
    .filter((range) => range.text.trim());
}

function textFromRanges(excerpt: string, ranges: SourceRange[]) {
  let output = '';
  let previous: SourceRange | undefined;
  for (const range of ranges) {
    if (previous && /\r?\n/.test(excerpt.slice(previous.end, range.start))) output += '\n';
    output += range.text.trim();
    previous = range;
  }
  return output;
}

export function prepareSourceText(excerpt: string): PreparedSourceText {
  const seen = new Set<string>();
  const segmenter = new Intl.Segmenter('zh', { granularity: 'sentence' });
  const ranges: SourceRange[] = [];
  for (const line of excerpt.matchAll(/[^\n]*(?:\n|$)/g)) {
    const raw = line[0].replace(/\n$/, '');
    if (!raw) continue;
    const leading = raw.length - raw.trimStart().length;
    const content = raw.trim();
    if (!content || isBoilerplateLine(content)) continue;
    const localSeen = new Set<string>();
    for (const sentence of segmenter.segment(content)) {
      const normalized = normalizedSentence(sentence.segment);
      if (normalized.length >= 18 && (localSeen.has(normalized) || seen.has(normalized))) continue;
      if (normalized.length >= 18) {
        localSeen.add(normalized);
        seen.add(normalized);
      }
      const start = (line.index ?? 0) + leading + sentence.index;
      ranges.push({ text: sentence.segment, start, end: start + sentence.segment.length });
    }
  }
  if (!ranges.length) return { text: excerpt, ranges: rangesForText(excerpt) };
  return { text: textFromRanges(excerpt, ranges), ranges };
}

/**
 * Remove only high-confidence publishing chrome before text is sent to the model.
 * The stored article excerpt remains untouched, including the exact evidence offsets.
 */
export function cleanSourceText(excerpt: string) {
  return prepareSourceText(excerpt).text;
}

export function sourcePassages(excerpt: string, ranges = rangesForText(excerpt)) {
  const chunks = ranges.flatMap((range) => {
    const rangeChunks: SourceRange[] = [];
    const characters = Array.from(range.text);
    let offset = range.start;
    for (let start = 0; start < characters.length; start += 1000) {
      const text = characters.slice(start, start + 1000).join('');
      rangeChunks.push({ text, start: offset, end: offset + text.length });
      offset += text.length;
    }
    return rangeChunks;
  });
  return chunks
    .filter((chunk) => chunk.text.length)
    .map((chunk, index) => ({ id: `S${index + 1}`, ...chunk }));
}

export function sourceFactSchema(
  passages: ReturnType<typeof sourcePassages>,
  sourceExcerpt = passages.map((passage) => passage.text).join(''),
) {
  const byId = new Map(passages.map((passage) => [passage.id, passage]));
  return z
    .object({
      statement: z.string().min(1).max(1000),
      evidenceIds: z
        .array(z.string())
        .min(1)
        .max(4)
        .superRefine((ids, ctx) => {
          ids.forEach((id, index) => {
            if (!byId.has(id))
              ctx.addIssue({
                code: 'custom',
                path: [index],
                message: `原文编号${id}不存在，请仅选择article.passages中的编号`,
              });
            if (ids.indexOf(id) !== index)
              ctx.addIssue({ code: 'custom', path: [index], message: '原文编号不能重复' });
          });
        }),
      status: z.enum(['confirmed', 'announced', 'planned', 'claim', 'rumor']),
      entities: z.array(z.string().max(100)).max(20).default([]),
    })
    .transform((fact) => {
      const cited = fact.evidenceIds.map((id) => byId.get(id)!);
      const start = Math.min(...cited.map((passage) => passage.start));
      const end = Math.max(...cited.map((passage) => passage.end));
      return { ...fact, evidence: sourceExcerpt.slice(start, end) };
    });
}
