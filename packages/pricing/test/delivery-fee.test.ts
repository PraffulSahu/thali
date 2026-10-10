import { describe, expect, it } from 'vitest';
import { computeDeliveryFee } from '../src/index.js';

const rule = { basePaise: 2000, baseKm: 2, perKmPaise: 700, maxPaise: 8000 };

describe('computeDeliveryFee', () => {
  it('charges the base fee within baseKm', () => {
    expect(computeDeliveryFee(0, rule)).toBe(2000);
    expect(computeDeliveryFee(1.5, rule)).toBe(2000);
    expect(computeDeliveryFee(2.0, rule)).toBe(2000);
  });
  it('charges per started km beyond baseKm', () => {
    expect(computeDeliveryFee(2.1, rule)).toBe(2700); // ceil(0.1)=1
    expect(computeDeliveryFee(3.0, rule)).toBe(2700); // ceil(1)=1
    expect(computeDeliveryFee(3.9, rule)).toBe(3400); // ceil(1.9)=2
  });
  it('does not overcharge on floating-point noise at whole-km boundaries', () => {
    const r = (baseKm: number) => ({ basePaise: 0, baseKm, perKmPaise: 100, maxPaise: 1_000_000 });
    expect(computeDeliveryFee(2.2, r(1.2))).toBe(100); // 2.2-1.2 = 1.0000000000000002 -> 1 km
    expect(computeDeliveryFee(4.4, r(1.4))).toBe(300); // 3.0000000000000004 -> 3 km
    expect(computeDeliveryFee(4.3, r(2.3))).toBe(200); // exactly 2 km
    expect(computeDeliveryFee(4.301, r(2.3))).toBe(300); // a real metre over still starts a km
    expect(computeDeliveryFee(1.2, r(1.2))).toBe(0);
  });
  it('caps at maxPaise', () => {
    expect(computeDeliveryFee(20, rule)).toBe(8000); // 2000+18*700=14600 -> 8000
  });
  it('rejects invalid distance', () => {
    expect(() => computeDeliveryFee(-1, rule)).toThrow(RangeError);
    expect(() => computeDeliveryFee(Number.NaN, rule)).toThrow(RangeError);
    expect(() => computeDeliveryFee(Number.POSITIVE_INFINITY, rule)).toThrow(RangeError);
  });
});
