import '../setup';
import { describe, expect, it } from 'vitest';
import { istDateToIso, isoToIstInput, istInputToIso, normalizeOrderDetail, paiseToRupees, rupeesToPaise } from '../../src/features/admin/api';
import { checkRefundInput } from '../../src/features/admin/OrderInvestigation';
import { bpsToPercent, percentToBps } from '../../src/features/admin/editors/CouponEditor';
import { pointsToPolygon, ringToPoints } from '../../src/features/admin/editors/ServiceAreaEditor';
import { safeNext } from '../../src/features/admin/AdminLogin';

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

  it('only redirects to admin pages after login', () => {
    expect(safeNext('/admin/orders')).toBe('/admin/orders');
    expect(safeNext('https://evil.example')).toBe('/admin');
    expect(safeNext('//evil.example')).toBe('/admin');
    expect(safeNext('/admin/login')).toBe('/admin');
    expect(safeNext('/restaurant')).toBe('/admin');
    expect(safeNext(null)).toBe('/admin');
  });

  it('normalizes order details tolerantly', () => {
    const d = normalizeOrderDetail({ id: 'g1', code: 'TH-1', status: 'COMPLETED', children: [{ id: 'c', restaurantName: 'R', status: 'DELIVERED', breakdown: { totalPaise: 100 } }] });
    expect(d.children[0]).toMatchObject({ id: 'c', totalPaise: 100, refundedPaise: 0, refundStatus: 'NONE' });
    expect(d.timeline).toEqual([]);
  });
});
