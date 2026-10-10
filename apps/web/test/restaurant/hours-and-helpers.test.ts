import '../setup';
import { describe, expect, it } from 'vitest';
import { missingForSubmit, normalizeDashboard, paiseToRupees, rupeesToPaise, validateUpload } from '../../src/features/restaurant/api';
import { emptyWeek, slotsFromWeek, slotKind, summarizeHours, validateWeek, weekFromSlots } from '../../src/features/restaurant/hours';
import { completeDraft, makeRestaurant } from './fixtures';

describe('hours', () => {
  it('allows a slot that runs past midnight (18:00 to 02:00) and an all-day slot', () => {
    const w = emptyWeek();
    w[5] = [{ open: '18:00', close: '02:00' }];
    w[6] = [{ open: '00:00', close: '00:00' }];
    expect(validateWeek(w).valid).toBe(true);
    expect(slotKind({ open: '18:00', close: '02:00' })).toBe('overnight');
    expect(slotKind({ open: '00:00', close: '00:00' })).toBe('allDay');
    expect(slotsFromWeek(w)).toEqual([{ day: 5, open: '18:00', close: '02:00' }, { day: 6, open: '00:00', close: '00:00' }]);
  });
  it('rejects an empty week, bad times and overlapping slots', () => {
    expect(validateWeek(emptyWeek()).errors.week).toBeDefined();
    const w = emptyWeek();
    w[1] = [{ open: '10:00', close: '14:00' }, { open: '13:00', close: '18:00' }, { open: '', close: '20:00' }];
    const { errors } = validateWeek(w);
    expect(errors['1.1']).toMatch(/overlaps/);
    expect(errors['1.2']).toBeDefined();
  });
  it('round-trips and summarises', () => {
    const slots = [{ day: 1, open: '09:00', close: '22:00' }, { day: 0, open: '10:00', close: '23:00' }];
    expect(slotsFromWeek(weekFromSlots(slots))).toEqual([{ day: 0, open: '10:00', close: '23:00' }, { day: 1, open: '09:00', close: '22:00' }]);
    expect(summarizeHours(slots)).toEqual(['Mon 09:00-22:00', 'Sun 10:00-23:00']);
  });
});

describe('money helpers (integer paise only)', () => {
  it('converts rupee text to paise without float drift', () => {
    expect(rupeesToPaise('249')).toBe(24900);
    expect(rupeesToPaise('249.5')).toBe(24950);
    expect(rupeesToPaise('0.29')).toBe(29);
    expect(rupeesToPaise('1,299.00')).toBe(129900);
    expect(rupeesToPaise('')).toBeNull();
    expect(rupeesToPaise('-5')).toBeNull();
    expect(rupeesToPaise('1.234')).toBeNull();
    expect(rupeesToPaise('abc')).toBeNull();
  });
  it('formats paise back to rupee text', () => {
    expect(paiseToRupees(24900)).toBe('249');
    expect(paiseToRupees(24950)).toBe('249.50');
    expect(paiseToRupees(5)).toBe('0.05');
  });
});

describe('upload validation', () => {
  it('enforces type and size per purpose', () => {
    expect(validateUpload({ type: 'image/png', size: 1000 }, 'IMAGE')).toBeNull();
    expect(validateUpload({ type: 'application/pdf', size: 1000 }, 'IMAGE')).toMatch(/isn't allowed/);
    expect(validateUpload({ type: 'image/png', size: 3 * 1024 * 1024 }, 'IMAGE')).toMatch(/too large/);
    expect(validateUpload({ type: 'application/pdf', size: 3 * 1024 * 1024 }, 'DOCUMENT')).toBeNull();
    expect(validateUpload({ type: 'image/png', size: 0 }, 'DOCUMENT')).toMatch(/empty/);
  });
});

describe('missingForSubmit', () => {
  it('lists every gap for a fresh draft and nothing for a complete one', () => {
    const keys = missingForSubmit(makeRestaurant({ status: 'DRAFT' })).map((m) => m.key);
    expect(keys).toEqual(expect.arrayContaining(['documents.FSSAI', 'documents.GST', 'documents.PAN', 'settlement']));
    expect(missingForSubmit(completeDraft())).toEqual([]);
  });
});

describe('normalizeDashboard', () => {
  it('reads plausible spellings and never invents numbers', () => {
    const m = normalizeDashboard({ ordersToday: 12, accepted: 9, rejected: 1, revenuePaise: 450000 });
    expect(m.ordersToday).toBe(12);
    expect(m.acceptanceRatePct).toBe(90);
    expect(m.revenuePaise).toBe(450000);
    const empty = normalizeDashboard({});
    expect(empty.ordersToday).toBeNull();
    expect(empty.acceptanceRatePct).toBeNull();
    expect(empty.revenuePaise).toBeNull();
    expect(normalizeDashboard({ acceptanceRate: 0.875 }).acceptanceRatePct).toBe(87.5);
    expect(normalizeDashboard({ acceptanceRateBps: 9250 }).acceptanceRatePct).toBe(92.5);
  });
});
