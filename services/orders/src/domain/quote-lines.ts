/**
 * Matching marketplace quote lines back to the requested (cart) lines of one restaurant.
 * Every quote item carries `lineRef` (= cart line id) and marketplace echoes it (LLD §8 step 2).
 *  - all response lines carry `lineRef` → strict match by lineRef (unmatched request → null)
 *  - otherwise → position fallback ONLY when every itemId is unique within the restaurant's request
 *    (then the itemId identifies the line unambiguously); else fail closed: 502 UPSTREAM_ERROR,
 *    because pricing the wrong customization would charge the wrong amount.
 */
import { DomainError } from '@thali/contracts';
import type { QuoteLine } from '../clients/marketplace.js';

export interface RequestedLine {
  lineRef: string;
  itemId: string;
}

export function matchQuoteLines(requested: readonly RequestedLine[], lines: readonly QuoteLine[]): (QuoteLine | null)[] {
  if (lines.every((l) => typeof l.lineRef === 'string')) {
    const byRef = new Map<string, QuoteLine>();
    for (const l of lines) byRef.set(l.lineRef!, l);
    return requested.map((r) => {
      const l = byRef.get(r.lineRef);
      return l && l.itemId === r.itemId ? l : null;
    });
  }
  const itemIds = requested.map((r) => r.itemId);
  if (new Set(itemIds).size !== itemIds.length) {
    throw new DomainError('UPSTREAM_ERROR', 'Marketplace quote lines cannot be matched to cart lines (missing lineRef)', 502, {
      target: 'marketplace',
      reason: 'QUOTE_LINE_REF_MISSING',
    });
  }
  return requested.map((r, idx) => {
    const atPos = lines[idx];
    if (atPos && atPos.itemId === r.itemId) return atPos;
    return lines.find((l) => l.itemId === r.itemId) ?? null;
  });
}
