import { describe, expect, it } from 'vitest';
import { evaluateBatch, type BatchPolicy } from '../src/domain/batching.js';
import { offsetKm } from '../src/domain/geo.js';

const policy: BatchPolicy = {
  maxActive: 2,
  pickupRadiusKm: 1.5,
  dropRadiusKm: 3,
  maxExtraMinutes: 12,
  roadFactor: 1.3,
  avgSpeedKmph: 20,
};

// Bengaluru-ish origin; offsets in km (north, east).
const A = { lat: 12.9716, lng: 77.5946 };
const at = (north: number, east: number) => offsetKm(A, north, east);

describe('evaluateBatch (LLD 7, pure)', () => {
  it('idle partner is eligible with zero extra minutes', () => {
    const r = evaluateBatch({ location: at(0.5, 0), activeJobIds: [] }, [], { pickup: A, drop: at(0, 3) }, policy);
    expect(r.eligible).toBe(true);
    expect(r.extraMinutes).toBe(0);
    expect(r.reasons.join(' ')).toContain('✓');
  });

  it('second job with pickups 0.8 km apart, drops 2 km apart, ~8 extra minutes is eligible with ✓ reasons', () => {
    // active: pickup A -> drop 3 km east. candidate: pickup 0.8 km toward dropA, drop 2 km north of dropA.
    const active = { id: 'j1', status: 'ASSIGNED' as const, restaurantId: 'r1', pickup: A, drop: at(0, 3) };
    const candidate = { restaurantId: 'r2', pickup: at(0, 0.8), drop: at(2, 3) };
    const r = evaluateBatch({ location: A, activeJobIds: ['j1'] }, [active], candidate, policy);
    expect(r.eligible).toBe(true);
    expect(r.extraMinutes).toBeGreaterThan(7);
    expect(r.extraMinutes).toBeLessThanOrEqual(8.5);
    expect(r.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^pickup 0\.8km ≤ 1\.5km ✓$/),
        expect.stringMatching(/^drop 2\.0km ≤ 3(\.0)?km ✓$/),
        expect.stringMatching(/^extra \d+(\.\d)?min ≤ 12min ✓$/),
      ]),
    );
    expect(r.reasons.every((s) => s.endsWith('✓'))).toBe(true);
  });

  it('pickups 2 km apart → ineligible with "pickup 2.0km > 1.5km"', () => {
    const active = { id: 'j1', status: 'ASSIGNED' as const, restaurantId: 'r1', pickup: A, drop: at(0, 3) };
    const r = evaluateBatch({ location: A, activeJobIds: ['j1'] }, [active], { restaurantId: 'r2', pickup: at(2, 0), drop: at(0, 3.5) }, policy);
    expect(r.eligible).toBe(false);
    expect(r.reasons.some((s) => s.includes('pickup 2.0km > 1.5km'))).toBe(true);
  });

  it('active job already PICKED_UP → ineligible', () => {
    const active = { id: 'j1', status: 'PICKED_UP' as const, restaurantId: 'r1', pickup: A, drop: at(0, 3) };
    const r = evaluateBatch({ location: A, activeJobIds: ['j1'] }, [active], { restaurantId: 'r2', pickup: at(0, 0.2), drop: at(0, 3.2) }, policy);
    expect(r.eligible).toBe(false);
    expect(r.reasons.some((s) => s.includes('already picked up') && s.endsWith('✗'))).toBe(true);
  });

  it('at max active deliveries → ineligible', () => {
    const j1 = { id: 'j1', status: 'ASSIGNED' as const, restaurantId: 'r1', pickup: A, drop: at(0, 3) };
    const j2 = { id: 'j2', status: 'ASSIGNED' as const, restaurantId: 'r1', pickup: A, drop: at(0.2, 3) };
    const r = evaluateBatch({ location: A, activeJobIds: ['j1', 'j2'] }, [j1, j2], { restaurantId: 'r1', pickup: A, drop: at(0.1, 3) }, policy);
    expect(r.eligible).toBe(false);
    expect(r.reasons.some((s) => s.includes('active 2 ≥ max 2'))).toBe(true);
  });

  it('extra minutes ~15 → ineligible', () => {
    // pickupB 0.8 km north (away from dropA), dropA 3 km south, dropB 2.25 km from dropA:
    // extra ≈ (0.8 + 3.8 + 2.25 − 3) km × 1.3 / 20 kmph ≈ 15 min
    const active = { id: 'j1', status: 'ASSIGNED' as const, restaurantId: 'r1', pickup: A, drop: at(-3, 0) };
    const r = evaluateBatch({ location: A, activeJobIds: ['j1'] }, [active], { restaurantId: 'r2', pickup: at(0.8, 0), drop: at(-3, 2.25) }, policy);
    expect(r.extraMinutes).toBeGreaterThan(14);
    expect(r.extraMinutes).toBeLessThan(16);
    expect(r.eligible).toBe(false);
    expect(r.reasons.some((s) => /^extra \d+(\.\d)?min > 12min ✗$/.test(s))).toBe(true);
  });

  it('same restaurant as a picked-up job is allowed by rule 2 (literal LLD wording)', () => {
    const active = { id: 'j1', status: 'PICKED_UP' as const, restaurantId: 'r1', pickup: A, drop: at(0, 3) };
    const r = evaluateBatch({ location: A, activeJobIds: ['j1'] }, [active], { restaurantId: 'r1', pickup: A, drop: at(0.5, 3) }, policy);
    expect(r.reasons.some((s) => s.includes('already picked up'))).toBe(false);
  });
});
