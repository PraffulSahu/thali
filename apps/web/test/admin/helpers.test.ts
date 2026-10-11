import '../setup';
import { describe, expect, it } from 'vitest';
import { istDateToIso, isoToIstInput, istInputToIso, normalizeOrderDetail, paiseToRupees, rupeesToPaise } from '../../src/features/admin/api';
import { checkRefundInput } from '../../src/features/admin/OrderInvestigation';
import { bpsToPercent, percentToBps } from '../../src/features/admin/editors/CouponEditor';
import { pointsToPolygon, ringToPoints } from '../../src/features/admin/editors/ServiceAreaEditor';
import { classifySearch } from '../../src/features/admin/CommandPalette';
import { retryOutcome } from '../../src/features/admin/bulk';
import { adminSubtitle, healthTone } from '../../src/features/admin/shell';
import { agoLabel, customerLabel, rangeToIso } from '../../src/features/admin/ui';

describe('admin input helpers', () => {
  it('converts rupees to paise with integer math and rejects junk', () => {
    expect(rupeesToPaise('12')).toBe(1200);
    expect(rupeesToPaise('12.5')).toBe(1250);
    expect(rupeesToPaise('1,200.05')).toBe(120005);
    expect(rupeesToPaise('0.1')).toBe(10);
    expect(rupeesToPaise('19.999')).toBeNull();
    expect(rupeesToPaise('-5')).toBeNull();
    expect(rupeesToPaise('abc')).toBeNull();
    expect(rupeesToPaise('')).toBeNull();
    expect(paiseToRupees(1250)).toBe('12.50');
    expect(paiseToRupees(1200)).toBe('12');
  });

  it('treats datetime-local values as Asia/Kolkata', () => {
    expect(istInputToIso('2026-10-10T18:30')).toBe('2026-10-10T13:00:00.000Z');
    expect(isoToIstInput('2026-10-10T13:00:00.000Z')).toBe('2026-10-10T18:30');
    expect(istDateToIso('2026-10-10', 'start')).toBe('2026-10-09T18:30:00.000Z');
    expect(istDateToIso('2026-10-10', 'end')).toBe('2026-10-10T18:29:59.999Z');
    expect(istDateToIso('bad', 'end')).toBeUndefined();
    expect(istInputToIso('garbage')).toBeNull();
  });

  it('converts percent to basis points', () => {
    expect(percentToBps('12.5')).toBe(1250);
    expect(percentToBps('100')).toBe(10000);
    expect(percentToBps('100.01')).toBeNull();
    expect(bpsToPercent(1250)).toBe('12.5');
    expect(bpsToPercent(500)).toBe('5');
  });

  it('validates refunds against what is still refundable', () => {
    expect(checkRefundInput('400', 40000)).toEqual({ paise: 40000, error: null });
    expect(checkRefundInput('0', 40000)).toEqual({ paise: 0, error: null });
    expect(checkRefundInput('400.01', 40000).error).toMatch(/cannot exceed ₹400\.00/);
    expect(checkRefundInput('', 40000).error).toBeTruthy();
    expect(checkRefundInput('1.234', 40000).error).toBeTruthy();
  });

  it('round-trips service area polygons as closed [lng, lat] rings', () => {
    const points = [{ lat: 12.9, lng: 77.5 }, { lat: 12.95, lng: 77.6 }, { lat: 13, lng: 77.55 }];
    const poly = pointsToPolygon(points);
    const ring = poly.coordinates[0]!;
    expect(ring).toHaveLength(points.length + 1);
    expect(ring[0]).toEqual([77.5, 12.9]);
    expect(ring[ring.length - 1]).toEqual(ring[0]);
    expect(ringToPoints({ polygon: poly } as never)).toEqual(points);
  });

  it('routes ⌘K input: TH- codes to orders, 4–13 digits to phone search, anything else to users/restaurants', () => {
    expect(classifySearch('  ')).toEqual({ kind: 'empty', term: '' });
    expect(classifySearch('th-k7z2')).toEqual({ kind: 'order', term: 'TH-K7Z2' });
    expect(classifySearch('3210')).toEqual({ kind: 'phone', term: '3210' });
    expect(classifySearch('+91 98765 43210')).toEqual({ kind: 'phone', term: '9876543210' });
    expect(classifySearch('123')).toEqual({ kind: 'text', term: '123' });
    expect(classifySearch('12345678901234')).toEqual({ kind: 'text', term: '12345678901234' });
    expect(classifySearch('Spice Route')).toEqual({ kind: 'text', term: 'Spice Route' });
  });

  it('reports what a bulk retry really re-queued', () => {
    expect(retryOutcome(12, 12)).toEqual({ title: 'Re-queued 12 notifications', description: undefined });
    expect(retryOutcome(9, 12).title).toBe('9 re-queued, 3 not retryable');
    expect(retryOutcome(0, 2).title).toBe('0 re-queued, 2 not retryable');
  });

  it('labels customers, refresh age, IST ranges, sub-roles and the health dot', () => {
    expect(customerLabel({ name: 'Prafful Sahu', phoneMasked: '+91 ••••• •3210' })).toBe('Prafful · ••3210');
    expect(customerLabel({ name: null, phoneMasked: null })).toBe('—');
    expect(agoLabel(Date.now() - 14_000, Date.now())).toBe('14s ago');
    const now = Date.parse('2026-10-11T10:00:00.000Z'); // 15:30 IST
    expect(rangeToIso('today', now)).toEqual({ from: '2026-10-10T18:30:00.000Z' });
    expect(rangeToIso('yesterday', now)).toEqual({ from: '2026-10-09T18:30:00.000Z', to: '2026-10-10T18:29:59.999Z' });
    expect(rangeToIso('all', now)).toEqual({});
    expect(adminSubtitle(['OPS'], true)).toBe('Ops admin · MFA on');
    expect(adminSubtitle(['FINANCE', 'SUPPORT'], true)).toBe('Finance · Support admin · MFA on');
    const svc = (status: 'up' | 'degraded' | 'down') => ({ status, latencyMs: 1 });
    const report = (services: Record<string, ReturnType<typeof svc>>) => ({ checkedAt: '', overall: 'up' as const, gateway: { status: 'up' as const, mode: 'demo', redis: 'up' as const }, services });
    expect(healthTone(report({ a: svc('up') }))).toBeNull();
    expect(healthTone(report({ a: svc('up'), b: svc('degraded') }))).toBe('warn');
    expect(healthTone(report({ a: svc('down'), b: svc('degraded') }))).toBe('bad');
  });

  it('normalizes order details tolerantly', () => {
    const d = normalizeOrderDetail({ id: 'g1', code: 'TH-1', status: 'COMPLETED', children: [{ id: 'c', restaurantName: 'R', status: 'DELIVERED', breakdown: { totalPaise: 100 } }] });
    expect(d.children[0]).toMatchObject({ id: 'c', totalPaise: 100, refundedPaise: 0, refundStatus: 'NONE' });
    expect(d.timeline).toEqual([]);
  });
});
