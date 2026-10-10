/** Search tokens: lower-cased, accent-free, de-duplicated words (prefix-matched via a multikey index). */
export function tokenize(...parts: (string | null | undefined)[]): string[] {
  const words = parts
    .filter((p): p is string => !!p)
    .join(' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return [...new Set(words)];
}

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `$and` of anchored prefix regexes, one per query word (all must match). null when q has no words. */
export function prefixTokenFilter(field: string, q: string, maxWords = 6): Record<string, unknown> | null {
  const words = tokenize(q).slice(0, maxWords);
  if (!words.length) return null;
  return { $and: words.map((w) => ({ [field]: { $regex: `^${escapeRegex(w)}` } })) };
}
