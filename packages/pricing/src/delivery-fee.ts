import type { DeliveryFeeRule } from './types.js';

/**
 * LLD §6: fee = min(maxPaise, basePaise + max(0, ceil(distanceKm - baseKm)) * perKmPaise).
 * Distance is a float (km) from the geo provider; the result is integer paise.
 */
export function computeDeliveryFee(distanceKm: number, rule: DeliveryFeeRule): number {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new RangeError(`distanceKm must be a finite non-negative number (got ${String(distanceKm)})`);
  }
  for (const [k, v] of Object.entries({
    basePaise: rule.basePaise,
    perKmPaise: rule.perKmPaise,
    maxPaise: rule.maxPaise,
  })) {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${k} must be a non-negative integer`);
  }
  if (!Number.isFinite(rule.baseKm) || rule.baseKm < 0) throw new RangeError('baseKm must be a finite non-negative number');
  const extraKm = Math.max(0, Math.ceil(distanceKm - rule.baseKm));
  return Math.min(rule.maxPaise, rule.basePaise + extraKm * rule.perKmPaise);
}
