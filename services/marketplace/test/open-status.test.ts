import { describe, expect, it } from 'vitest';
import { isOpenAt } from '../src/domain/open-status.js';

// 2026-10-12 is a Monday. IST = UTC+05:30.
const ist = (local: string) => new Date(`${local}+05:30`);
const base = { status: 'APPROVED' as const, timezone: 'Asia/Kolkata', pausedUntil: null };

describe('isOpenAt (Review Focus #1: overnight hours + IST day boundary)', () => {
  const overnight = { ...base, hours: [{ day: 1, open: '18:00', close: '02:00' }] }; // Mon 18:00 – Tue 02:00

  it('Mon 18:00–02:00: Tue 01:30 IST is open (spill-over from Monday)', () => {
    expect(isOpenAt(overnight, ist('2026-10-13T01:30:00'))).toEqual({ open: true });
    // same instant expressed in UTC: Monday 20:00Z
    expect(isOpenAt(overnight, new Date('2026-10-12T20:00:00Z')).open).toBe(true);
  });

  it('Mon 18:00–02:00: Tue 02:30 IST is closed; next opening is next Monday 18:00 IST', () => {
    const r = isOpenAt(overnight, ist('2026-10-13T02:30:00'));
    expect(r.open).toBe(false);
    expect(r.reason).toBe('OUTSIDE_HOURS');
    expect(r.nextOpenAt?.toISOString()).toBe(ist('2026-10-19T18:00:00').toISOString());
  });

  it('closing minute is exclusive and opening minute inclusive', () => {
    expect(isOpenAt(overnight, ist('2026-10-13T02:00:00')).open).toBe(false);
    expect(isOpenAt(overnight, ist('2026-10-12T18:00:00')).open).toBe(true);
    expect(isOpenAt(overnight, ist('2026-10-12T17:59:00'))).toMatchObject({
      open: false,
      reason: 'OUTSIDE_HOURS',
      nextOpenAt: ist('2026-10-12T18:00:00'),
    });
  });

  it('a Sunday-evening UTC instant that is Monday morning IST uses Monday hours', () => {
    const r = { ...base, hours: [{ day: 1, open: '03:00', close: '11:00' }] }; // Monday only
    const sundayUtcEvening = new Date('2026-10-11T22:00:00Z'); // = Mon 03:30 IST
    expect(sundayUtcEvening.getUTCDay()).toBe(0);
    expect(isOpenAt(r, sundayUtcEvening)).toEqual({ open: true });

    // and Sunday hours do NOT apply at that instant
    const sundayOnly = { ...base, hours: [{ day: 0, open: '00:00', close: '23:59' }] };
    expect(isOpenAt(sundayOnly, sundayUtcEvening).open).toBe(false);
  });

  it('Monday 00:30 IST is closed when only Monday 18:00–02:00 exists (no Sunday overnight slot)', () => {
    const r = isOpenAt(overnight, new Date('2026-10-11T19:00:00Z')); // Sun 19:00Z = Mon 00:30 IST
    expect(r.open).toBe(false);
    expect(r.nextOpenAt?.toISOString()).toBe(ist('2026-10-12T18:00:00').toISOString());
  });

  it('a Sunday overnight slot spills into Monday early hours', () => {
    const r = { ...base, hours: [{ day: 0, open: '20:00', close: '01:00' }] };
    expect(isOpenAt(r, ist('2026-10-12T00:30:00')).open).toBe(true); // Monday 00:30 IST
    expect(isOpenAt(r, ist('2026-10-12T01:30:00')).open).toBe(false);
  });

  it('open == close means open around the clock', () => {
    const r = { ...base, hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '00:00' })) };
    expect(isOpenAt(r, ist('2026-10-14T13:13:00')).open).toBe(true);
    expect(isOpenAt(r, ist('2026-10-14T00:00:00')).open).toBe(true);
  });

  it('no hours configured → closed, no nextOpenAt', () => {
    const r = isOpenAt({ ...base, hours: [] }, ist('2026-10-14T13:00:00'));
    expect(r).toEqual({ open: false, reason: 'OUTSIDE_HOURS' });
  });

  it('paused until a future time → closed PAUSED with nextOpenAt = pausedUntil when hours allow', () => {
    const pausedUntil = ist('2026-10-12T19:00:00');
    const r = isOpenAt({ ...overnight, pausedUntil }, ist('2026-10-12T18:30:00'));
    expect(r).toEqual({ open: false, reason: 'PAUSED', nextOpenAt: pausedUntil });
  });

  it('paused past closing time → nextOpenAt is the next slot after the pause', () => {
    const r = isOpenAt({ ...overnight, pausedUntil: ist('2026-10-13T03:00:00') }, ist('2026-10-12T23:00:00'));
    expect(r.reason).toBe('PAUSED');
    expect(r.nextOpenAt?.toISOString()).toBe(ist('2026-10-19T18:00:00').toISOString());
  });

  it('a pause that has ended no longer applies', () => {
    expect(isOpenAt({ ...overnight, pausedUntil: ist('2026-10-12T18:10:00') }, ist('2026-10-12T18:30:00'))).toEqual({ open: true });
  });

  it('non-approved restaurants are closed with NOT_APPROVED', () => {
    for (const status of ['DRAFT', 'VERIFICATION_PENDING', 'APPROVAL_PENDING', 'REJECTED', 'SUSPENDED'] as const) {
      expect(isOpenAt({ ...overnight, status }, ist('2026-10-12T19:00:00'))).toEqual({ open: false, reason: 'NOT_APPROVED' });
    }
  });

  it('multiple slots per day (lunch + dinner)', () => {
    const r = {
      ...base,
      hours: [
        { day: 3, open: '12:00', close: '15:00' },
        { day: 3, open: '19:00', close: '23:00' },
      ],
    };
    expect(isOpenAt(r, ist('2026-10-14T13:00:00')).open).toBe(true); // Wednesday
    const gap = isOpenAt(r, ist('2026-10-14T16:00:00'));
    expect(gap.open).toBe(false);
    expect(gap.nextOpenAt?.toISOString()).toBe(ist('2026-10-14T19:00:00').toISOString());
  });
});
