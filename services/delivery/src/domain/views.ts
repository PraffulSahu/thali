/** API views (no handover hashes, no storage keys, no internal counters beyond what each audience needs). */
import type { JobLean } from '../models/delivery-job.js';
import type { OfferLean } from '../models/delivery-offer.js';
import type { PartnerLean } from '../models/partner.js';
import { mapsUrl, toLatLng } from './geo.js';

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const loc = (p: { coordinates: number[] } | null | undefined) => (p && p.coordinates?.length === 2 ? toLatLng(p) : null);

export function partnerView(p: PartnerLean) {
  return {
    id: p._id.toString(),
    userId: p.userId,
    name: p.name,
    phone: p.phone ?? null,
    vehicle: p.vehicle ? { type: p.vehicle.type, registrationNumber: p.vehicle.registrationNumber } : null,
    status: p.status,
    statusReason: p.statusReason ?? null,
    documents: (p.documents ?? []).map((d) => ({
      id: (d as { _id: { toString(): string } })._id.toString(),
      type: d.type,
      demoVerified: d.demoVerified,
      uploadedAt: iso(d.uploadedAt),
    })),
    online: p.online,
    lastLocation: loc(p.lastLocation),
    lastLocationAt: iso(p.lastLocationAt),
    activeJobIds: (p.activeJobIds ?? []).map(String),
    maxActive: p.maxActive,
    isDemo: p.isDemo,
    createdAt: iso(p.createdAt),
  };
}

function place(p: { name: string; address: string; location: { coordinates: number[] } }) {
  return { name: p.name, address: p.address, location: toLatLng(p.location) };
}

/** Job as seen by its assigned partner. */
export function partnerJobView(j: JobLean, codeMaxAttempts: number) {
  const pickup = place(j.pickup);
  const drop = { ...place(j.drop), phoneMasked: j.drop.phoneMasked };
  return {
    id: j._id.toString(),
    childOrderId: j.childOrderId,
    status: j.status,
    pickup,
    drop,
    distanceKm: j.distanceKm,
    estimatedMinutes: j.estimatedMinutes,
    estimateSource: j.estimateSource,
    prepMinutes: j.prepMinutes ?? null,
    readyEta: iso(j.readyEta),
    readyAt: iso(j.readyAt),
    codeAttemptsRemaining: Math.max(0, codeMaxAttempts - (j.codeAttempts ?? 0)),
    navigation: { pickupUrl: mapsUrl(pickup.location), dropUrl: mapsUrl(drop.location) },
    assignedAt: iso(j.assignedAt),
    pickedUpAt: iso(j.pickedUpAt),
    deliveredAt: iso(j.deliveredAt),
    failureReason: j.failureReason ?? null,
    createdAt: iso(j.createdAt),
  };
}

/** Job as seen by admins (TMS). */
export function adminJobView(j: JobLean) {
  return {
    id: j._id.toString(),
    childOrderId: j.childOrderId,
    checkoutGroupId: j.checkoutGroupId,
    restaurantId: j.restaurantId,
    customerUserId: j.customerUserId,
    status: j.status,
    partnerId: j.partnerId ? j.partnerId.toString() : null,
    partnerUserId: j.partnerUserId ?? null,
    pickup: place(j.pickup),
    drop: { ...place(j.drop), phoneMasked: j.drop.phoneMasked },
    dispatchRound: j.dispatchRound,
    exception: j.exception,
    exceptionReason: j.exceptionReason ?? null,
    distanceKm: j.distanceKm,
    estimatedMinutes: j.estimatedMinutes,
    estimateSource: j.estimateSource,
    codeAttempts: j.codeAttempts ?? 0,
    readyAt: iso(j.readyAt),
    failureReason: j.failureReason ?? null,
    lastLocation: loc(j.lastLocation),
    lastLocationAt: iso(j.lastLocationAt),
    locationSimulated: j.locationSimulated,
    statusHistory: (j.statusHistory ?? []).map((h) => ({ from: h.from ?? null, to: h.to, at: iso(h.at), actor: h.actor, actorId: h.actorId ?? null, reason: h.reason ?? null })),
    assignedAt: iso(j.assignedAt),
    pickedUpAt: iso(j.pickedUpAt),
    deliveredAt: iso(j.deliveredAt),
    createdAt: iso(j.createdAt),
  };
}

/** Offer as seen by the offered partner (drop phone hidden until assigned). */
export function offerView(o: OfferLean, j: JobLean | undefined) {
  return {
    id: o._id.toString(),
    jobId: o.jobId.toString(),
    status: o.status,
    round: o.round,
    expiresAt: iso(o.expiresAt),
    distanceToPickupKm: o.distanceToPickupKm,
    batchEvaluation: { eligible: o.batchEvaluation.eligible, reasons: o.batchEvaluation.reasons, extraMinutes: o.batchEvaluation.extraMinutes ?? 0 },
    job: j
      ? {
          childOrderId: j.childOrderId,
          pickup: place(j.pickup),
          drop: place(j.drop),
          distanceKm: j.distanceKm,
          estimatedMinutes: j.estimatedMinutes,
          estimateSource: j.estimateSource,
          readyEta: iso(j.readyEta),
        }
      : null,
  };
}
