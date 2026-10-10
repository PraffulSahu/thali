import { describe, expect, it } from 'vitest';
import { fitReasons, formatReason, formatRupeesShort, groupUtr, istWeekStart, ordinal, partnerStep } from '../../src/features/partner/format';

describe('partner format helpers', () => {
  it('ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
  });

  it('reformats the batching reasons from the delivery service for the fit list', () => {
    expect(formatReason('pickup 0.8km ≤ 1.5km ✓')).toEqual({ ok: true, text: 'pickup 0.8 km ≤ 1.5 km' });
    expect(formatReason('extra 8.0min ≤ 12min ✓')).toEqual({ ok: true, text: 'extra time 8 min ≤ 12 min' });
    expect(formatReason('drop 2.4km > 2km ✗')).toEqual({ ok: false, text: 'drop 2.4 km > 2 km' });
    expect(fitReasons(['idle partner ✓'])).toEqual([]);
  });

  it('short rupees, UTR grouping', () => {
    expect(formatRupeesShort(64200)).toBe('₹642');
    expect(formatRupeesShort(64250)).toBe('₹642.50');
    expect(formatRupeesShort(34100000)).toBe('₹3,41,000');
    expect(groupUtr('402188331190')).toBe('4021 8833 1190');
  });

  it('IST week start is Monday 00:00 +05:30', () => {
    // Sunday 11 Oct 2026, 20:00 UTC = Monday 12 Oct 01:30 IST → that Monday
    expect(istWeekStart(Date.parse('2026-10-11T20:00:00Z'))).toBe('2026-10-12T00:00:00+05:30');
    // Sunday 11 Oct 2026, 10:00 UTC = Sunday 15:30 IST → Monday 5 Oct
    expect(istWeekStart(Date.parse('2026-10-11T10:00:00Z'))).toBe('2026-10-05T00:00:00+05:30');
  });

  it('maps job status to the current partner step', () => {
    expect(['ASSIGNED', 'AT_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY'].map((s) => partnerStep(s as never))).toEqual([0, 1, 2, 3]);
  });
});
