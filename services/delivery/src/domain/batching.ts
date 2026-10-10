/**
 * Explainable batching policy (LLD 7). Pure: no I/O, no clock.
 *
 * A partner with active jobs may take candidate job j iff
 *  1. active count < maxActive
 *  2. every active job is not yet PICKED_UP, or shares j's pickup restaurant
 *  3. distance(j.pickup, active.pickup) ≤ pickupRadiusKm   (straight line)
 *  4. distance(j.drop, active.drop)     ≤ dropRadiusKm     (straight line)
 *  5. extraMinutes ≤ maxExtraMinutes, where extraMinutes =
 *       time(p → active pickups → j.pickup → active drops → j.drop) − time(p → active pickups → active drops)
 *     (for one active job A: time(p→pickupA→pickupB→dropA→dropB) − time(p→pickupA→dropA)),
 *     time = haversine × roadFactor / avgSpeedKmph.
 * Every rule appends a human-readable reason ending in ✓ / ✗ (shown in the partner UI).
 */
import { haversineKm, routeMinutes, type LatLng } from './geo.js';

export interface BatchPolicy {
  maxActive: number;
  pickupRadiusKm: number;
  dropRadiusKm: number;
  maxExtraMinutes: number;
  roadFactor: number;
  avgSpeedKmph: number;
}

export interface PartnerState {
  location: LatLng;
  activeJobIds: string[];
}

export interface ActiveJob {
  id: string;
  status: string;
  restaurantId?: string;
  pickup: LatLng;
  drop: LatLng;
}

export interface CandidateJob {
  restaurantId?: string;
  pickup: LatLng;
  drop: LatLng;
}

export interface BatchEvaluation {
  eligible: boolean;
  reasons: string[];
  /** Extra minutes added for existing customers (1 decimal). 0 for idle partners. */
  extraMinutes: number;
}

const PICKED_UP_STATES = new Set(['PICKED_UP', 'OUT_FOR_DELIVERY']);
const km = (v: number) => `${v.toFixed(1)}km`;
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

export function evaluateBatch(partner: PartnerState, activeJobs: ActiveJob[], candidate: CandidateJob, policy: BatchPolicy): BatchEvaluation {
  const activeCount = Math.max(partner.activeJobIds.length, activeJobs.length);
  if (activeCount === 0) {
    return { eligible: true, reasons: ['idle partner ✓'], extraMinutes: 0 };
  }

  const reasons: string[] = [];
  let eligible = true;
  const check = (ok: boolean, text: string) => {
    reasons.push(`${text} ${ok ? '✓' : '✗'}`);
    if (!ok) eligible = false;
  };

  // 1. capacity
  if (activeCount < policy.maxActive) check(true, `active ${activeCount} < max ${policy.maxActive}`);
  else check(false, `active ${activeCount} ≥ max ${policy.maxActive}`);

  for (const job of activeJobs) {
    // 2. only batch before pickup (or same restaurant)
    const sameRestaurant = !!candidate.restaurantId && candidate.restaurantId === job.restaurantId;
    if (PICKED_UP_STATES.has(job.status) && !sameRestaurant) check(false, `active job already picked up`);

    // 3. pickups close together
    const pickupKm = haversineKm(candidate.pickup, job.pickup);
    const pickupOk = pickupKm <= policy.pickupRadiusKm;
    check(pickupOk, `pickup ${km(pickupKm)} ${pickupOk ? '≤' : '>'} ${fmt(policy.pickupRadiusKm)}km`);

    // 4. drops close together
    const dropKm = haversineKm(candidate.drop, job.drop);
    const dropOk = dropKm <= policy.dropRadiusKm;
    check(dropOk, `drop ${km(dropKm)} ${dropOk ? '≤' : '>'} ${fmt(policy.dropRadiusKm)}km`);
  }

  // 5. delay to existing customers
  const model = { roadFactor: policy.roadFactor, avgSpeedKmph: policy.avgSpeedKmph };
  const pendingPickups = activeJobs.filter((j) => !PICKED_UP_STATES.has(j.status)).map((j) => j.pickup);
  const drops = activeJobs.map((j) => j.drop);
  const base = routeMinutes([partner.location, ...pendingPickups, ...drops], model);
  const withCandidate = routeMinutes([partner.location, ...pendingPickups, candidate.pickup, ...drops, candidate.drop], model);
  const extraRaw = Math.max(0, withCandidate - base);
  const extraMinutes = Math.round(extraRaw * 10) / 10;
  const extraOk = extraRaw <= policy.maxExtraMinutes;
  check(extraOk, `extra ${extraMinutes.toFixed(1)}min ${extraOk ? '≤' : '>'} ${fmt(policy.maxExtraMinutes)}min`);

  return { eligible, reasons, extraMinutes };
}
