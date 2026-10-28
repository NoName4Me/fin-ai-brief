export function cleanBriefTitle(title: string) {
  return title
    .trim()
    .replace(/^(?:(?:AI日报|《?数智参阅》?(?:第\d+期)?)\s*[｜|]\s*)+/i, '')
    .trim();
}
