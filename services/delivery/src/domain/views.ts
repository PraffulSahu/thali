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

/** DLV-2 fallback for jobs created before `drop.area` existed: the last 6-digit pincode in the address. */
export function areaFromAddress(address: string | null | undefined): string | null {
  const pins = (address ?? '').match(/\b\d{6}\b/g);
  return pins?.length ? pins[pins.length - 1]! : null;
}

type DropLike = { address: string; area?: string | null; label?: string | null };
export const dropArea = (d: DropLike): string | null => d.area?.trim() || areaFromAddress(d.address);

/**
 * DLV-2: the full drop address (and exact coordinates) reach the assigned partner only once the food
 * is picked up; before that the partner sees area + label (design: "Full address after pickup").
 */
const REVEALED_STATUSES = new Set(['PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED']);
export function dropRevealed(j: Pick<JobLean, 'status' | 'pickedUpAt'>): boolean {
  return REVEALED_STATUSES.has(j.status) || !!j.pickedUpAt;
}

const round1 = (km: number) => Math.round(km * 10) / 10;

/** Job as seen by its assigned partner. */
export function partnerJobView(j: JobLean, codeMaxAttempts: number) {
  const pickup = place(j.pickup);
  const revealed = dropRevealed(j);
  const dropLocation = revealed ? toLatLng(j.drop.location) : null;
  const drop = {
    name: j.drop.name,
    area: dropArea(j.drop),
    label: j.drop.label ?? null,
    address: revealed ? j.drop.address : null,
    location: dropLocation,
    addressRevealed: revealed,
    phoneMasked: j.drop.phoneMasked,
  };
  return {
    id: j._id.toString(),
    childOrderId: j.childOrderId,
    childOrderCode: j.childOrderCode ?? null,
    checkoutCode: j.checkoutCode ?? null,
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
    navigation: { pickupUrl: mapsUrl(pickup.location), dropUrl: dropLocation ? mapsUrl(dropLocation) : null },
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
    childOrderCode: j.childOrderCode ?? null,
    checkoutCode: j.checkoutCode ?? null,
    checkoutGroupId: j.checkoutGroupId,
    restaurantId: j.restaurantId,
    customerUserId: j.customerUserId,
    status: j.status,
    partnerId: j.partnerId ? j.partnerId.toString() : null,
    partnerUserId: j.partnerUserId ?? null,
    pickup: place(j.pickup),
    drop: { ...place(j.drop), phoneMasked: j.drop.phoneMasked, area: dropArea(j.drop), label: j.drop.label ?? null },
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

/**
 * Offer as seen by the offered partner. DLV-2 privacy: the drop is reduced to its area and the
 * pickup→drop distance (0.1 km) — no customer name, address line, label, phone or coordinates.
 */
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
          drop: { area: dropArea(j.drop), distanceFromPickupKm: round1(j.distanceKm) },
          distanceKm: j.distanceKm,
          estimatedMinutes: j.estimatedMinutes,
          estimateSource: j.estimateSource,
          readyEta: iso(j.readyEta),
        }
      : null,
  };
}
