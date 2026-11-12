// Older editions may contain model-only citation markers. Sources remain linked separately.
export function rotationText(text: string) {
  return text
    .replace(/\s*[（(]\s*[EF]\d{1,}(?:\s*[,，、]\s*[EF]\d{1,})*\s*[)）]/g, '')
    .replace(/\b[EF]\d{2,}\b/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
