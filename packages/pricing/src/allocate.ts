export function assertNonNegativeInt(v: number, what: string): void {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new RangeError(`${what} must be a non-negative integer (got ${String(v)})`);
  }
}

/**
 * Largest-remainder pro-rata allocation of `totalPaise` over `weights`.
 *
 * - If sum(w) = 0, everything goes to the first key. "First" is deterministic: the
 *   smallest key in ascending (code-unit) order, independent of input order.
 * - Otherwise base_k = floor(T * w_k / sum(w)); the remainder R = T - sum(base) is
 *   distributed +1 each to the R keys with the largest fractional part
 *   (T * w_k) mod sum(w); ties broken by key ascending.
 * - Sum of result == totalPaise exactly. Uses BigInt internally so T * w never loses precision.
 *
 * Throws RangeError for a negative / non-integer total or weight, or duplicate keys.
 */
export function allocateProRata(
  totalPaise: number,
  weights: { key: string; weight: number }[],
): Record<string, number> {
  assertNonNegativeInt(totalPaise, 'totalPaise');
  const seen = new Set<string>();
  for (const { key, weight } of weights) {
    assertNonNegativeInt(weight, `weight[${key}]`);
    if (seen.has(key)) throw new RangeError(`duplicate allocation key: ${key}`);
    seen.add(key);
  }
  if (weights.length === 0) {
    if (totalPaise === 0) return {};
    throw new RangeError('cannot allocate a non-zero total over no keys');
  }

  const sorted = [...weights].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const out: Record<string, number> = {};
  const sumW = sorted.reduce((acc, w) => acc + BigInt(w.weight), 0n);

  if (sumW === 0n) {
    sorted.forEach((w, i) => {
      out[w.key] = i === 0 ? totalPaise : 0;
    });
    return out;
  }

  const T = BigInt(totalPaise);
  const parts = sorted.map((w) => {
    const prod = T * BigInt(w.weight);
    return { key: w.key, base: prod / sumW, frac: prod % sumW };
  });
  let remainder = Number(T - parts.reduce((acc, p) => acc + p.base, 0n));

  // Stable sort: equal fractions keep key-ascending order (parts already sorted by key).
  const byFrac = [...parts].sort((a, b) => (a.frac > b.frac ? -1 : a.frac < b.frac ? 1 : 0));
  const bonus = new Set<string>();
  for (const p of byFrac) {
    if (remainder <= 0) break;
    bonus.add(p.key);
    remainder -= 1;
  }
  for (const p of parts) out[p.key] = Number(p.base) + (bonus.has(p.key) ? 1 : 0);
  return out;
}
