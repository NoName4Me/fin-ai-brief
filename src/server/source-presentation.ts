export function sourceName(name: string) {
  let clean = name.trim();
  let previous: string;
  do {
    previous = clean;
    clean = clean
      .replace(/\s*[（(]\s*(?:网页|RSS)(?:\s*[·、，,：:/-][^）)]*)?\s*[）)]\s*$/i, '')
      .trim();
  } while (clean !== previous);
  return clean || '来源';
}
export function isXSource(source: { name: string; url: string }) {
  try {
    const host = new URL(source.url).hostname.toLowerCase();
    if (
      host === 'x.com' ||
      host.endsWith('.x.com') ||
      host === 'twitter.com' ||
      host.endsWith('.twitter.com')
    )
      return true;
  } catch {
    /* 历史来源仍可按名称排序。 */
  }
  return /^(?:X|Twitter)(?:\s*[:：·（(@]|\s*$)/i.test(source.name.trim());
}
export function orderedSources<T extends { name: string; url: string }>(sources: T[]) {
  return [...sources].sort((a, b) => Number(isXSource(a)) - Number(isXSource(b)));
}
export function sourceNames(sources: { name: string; url: string }[]) {
  return [...new Set(orderedSources(sources).map((source) => sourceName(source.name)))];
}
