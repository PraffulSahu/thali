/**
 * Partner API: types (mirroring services/delivery + services/payments zod views) and thin fetchers.
 * Money is integer paise. Paths are relative to /api/v1 (see lib/api.ts).
 */
import type { GeoPoint, Paginated } from '@thali/contracts';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { isNotFound } from '../../lib/errors';

export type { GeoPoint, Paginated };

export type PartnerStatusValue = 'DRAFT' | 'APPROVAL_PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
export type VehicleTypeValue = 'BIKE' | 'SCOOTER' | 'BICYCLE' | 'CAR';
export type DocType = 'ID_PROOF' | 'DRIVING_LICENSE' | 'VEHICLE_RC';
export type DeliveryStatusValue =
  | 'PENDING_ASSIGNMENT' | 'OFFERED' | 'ASSIGNED' | 'AT_PICKUP' | 'PICKED_UP' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'FAILED' | 'CANCELLED';

export const VEHICLE_OPTIONS: { value: VehicleTypeValue; label: string }[] = [
  { value: 'BIKE', label: 'Motorbike' },
  { value: 'SCOOTER', label: 'Scooter' },
  { value: 'BICYCLE', label: 'Bicycle' },
  { value: 'CAR', label: 'Car' },
];

export const DOC_LABELS: Record<DocType, string> = {
  ID_PROOF: 'ID proof (Aadhaar, voter ID or passport)',
  DRIVING_LICENSE: 'Driving licence',
  VEHICLE_RC: 'Vehicle registration certificate (RC)',
};

/** Mirrors `missingForSubmit` in services/delivery/src/domain/onboarding.ts. */
export function requiredDocs(vehicle: VehicleTypeValue | null | undefined): DocType[] {
  return vehicle === 'BICYCLE' ? ['ID_PROOF'] : ['ID_PROOF', 'DRIVING_LICENSE', 'VEHICLE_RC'];
}

export const DOC_CONTENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
/** Server default PARTNER_DOC_MAX_BYTES; the server remains the authority (FILE_INVALID). */
export const DOC_MAX_BYTES = 5 * 1024 * 1024;

export interface PartnerDocument {
  id: string;
  type: DocType;
  demoVerified: boolean;
  uploadedAt: string | null;
}

export interface PartnerProfile {
  id: string;
  userId: string;
  name: string;
  phone: string | null;
  vehicle: { type: VehicleTypeValue; registrationNumber: string } | null;
  status: PartnerStatusValue;
  statusReason: string | null;
  documents: PartnerDocument[];
  online: boolean;
  lastLocation: GeoPoint | null;
  lastLocationAt: string | null;
  activeJobIds: string[];
  maxActive: number;
  isDemo: boolean;
  createdAt: string | null;
}

export interface Place {
  name: string;
  address: string;
  location: GeoPoint;
}

/**
 * Drop as the ASSIGNED partner sees it (DLV-2). `address`, `location` and `navigation.dropUrl` are null until the
 * food is picked up (`addressRevealed` true only while PICKED_UP / OUT_FOR_DELIVERY); history shows area + label only.
 */
export interface PartnerJobDrop {
  name: string;
  /** Locality (falls back to the pincode on old jobs); null when unknown. */
  area: string | null;
  /** Address label, e.g. "Home". */
  label: string | null;
  address: string | null;
  location: GeoPoint | null;
  addressRevealed: boolean;
  phoneMasked: string;
}

export interface PartnerJob {
  id: string;
  childOrderId: string;
  childOrderCode: string | null;
  checkoutCode: string | null;
  status: DeliveryStatusValue;
  pickup: Place;
  drop: PartnerJobDrop;
  distanceKm: number;
  estimatedMinutes: number;
  estimateSource: string;
  prepMinutes: number | null;
  readyEta: string | null;
  readyAt: string | null;
  codeAttemptsRemaining: number;
  navigation: { pickupUrl: string; dropUrl: string | null };
  assignedAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  failureReason: string | null;
  createdAt: string | null;
}

export interface BatchEvaluation {
  eligible: boolean;
  reasons: string[];
  extraMinutes: number;
}

/** Offer drop (DLV-2 privacy): area + rounded pickup→drop distance only. No name, address, label, phone or coordinates. */
export interface OfferDrop {
  area: string | null;
  distanceFromPickupKm: number;
}

export interface Offer {
  id: string;
  jobId: string;
  status: string;
  round: number;
  expiresAt: string | null;
  distanceToPickupKm: number;
  batchEvaluation: BatchEvaluation;
  job: {
    childOrderId: string;
    pickup: Place;
    drop: OfferDrop;
    /** Rounded to 0.1 km. */
    distanceKm: number;
    /** Whole minutes. */
    estimatedMinutes: number;
    estimateSource: string;
    readyEta: string | null;
  } | null;
}

export type ContactTarget = 'CUSTOMER' | 'RESTAURANT';
/** DLV-1 `POST /deliveries/:jobId/contact` result. DEMO never carries a number to dial. */
export interface ContactResult {
  target: ContactTarget;
  mode: 'DIRECT' | 'PROXY' | 'DEMO';
  telUrl: string | null;
  displayNumber: string;
  expiresAt: string;
  note: string | null;
}

export interface UploadTicket {
  key: string;
  upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string; maxBytes: number };
}

/** payments `AccountSummary` (services/payments/src/schemas.ts). */
export interface FinanceSummary {
  accountType: string;
  accountId: string;
  balancePaise: number;
  availablePaise: number;
  pendingPayoutPaise: number;
  paidOutPaise: number;
  holdDays: number;
  totalsByType: Record<string, number>;
  asOf: string;
  /** PAY-1 earnings window (default: today in IST). Absent on older payments builds. */
  window?: EarningsWindow;
}
export interface EarningsWindow {
  from: string;
  to: string;
  /** Partner: DELIVERY_EARNING only (payouts and adjustments excluded). */
  earningsPaise: number;
  entriesByType: Record<string, number>;
  /** One DELIVERY_EARNING entry per delivered job. */
  deliveries: number;
}
export interface LedgerEntry {
  id: string;
  entryType: string;
  amountPaise: number;
  childOrderId: string | null;
  deliveryJobId: string | null;
  payoutId: string | null;
  memo: string;
  createdAt: string;
}
export interface Payout {
  id: string;
  amountPaise: number;
  status: string;
  method: string;
  utr: string | null;
  failureReason: string | null;
  notes: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const partnerKeys = {
  profile: ['partner', 'profile'] as const,
  offers: ['partner', 'offers'] as const,
  active: ['partner', 'active'] as const,
  history: (cursor?: string) => ['partner', 'history', cursor ?? null] as const,
  summary: (from?: string) => ['partner', 'finance', 'summary', from ?? 'today'] as const,
  lastPayout: ['partner', 'finance', 'payouts', 'latest'] as const,
  ledger: (cursor?: string) => ['partner', 'finance', 'ledger', cursor ?? null] as const,
  payouts: (cursor?: string) => ['partner', 'finance', 'payouts', cursor ?? null] as const,
};

// ---- onboarding
export const getProfile = (signal?: AbortSignal) => api<PartnerProfile>('/partner/profile', { signal });
/** Shared by the area layout, home and onboarding. A 404 means "no profile yet" and is not retried. */
export const profileQueryOptions = () =>
  queryOptions({
    queryKey: partnerKeys.profile,
    queryFn: ({ signal }) => getProfile(signal),
    retry: (n: number, e: unknown) => !isNotFound(e) && n < 2,
  });
export const createProfile = (body: { name?: string; vehicle?: { type: VehicleTypeValue; registrationNumber: string } }) =>
  api<PartnerProfile>('/partner/profile', { method: 'POST', body });
export const updateProfile = (body: { name?: string; vehicle?: { type: VehicleTypeValue; registrationNumber: string } }) =>
  api<PartnerProfile>('/partner/profile', { method: 'PATCH', body });
export const presignDocument = (body: { type: DocType; contentType: string; sizeBytes: number }) =>
  api<UploadTicket>('/partner/uploads', { method: 'POST', body });
export const attachDocument = (body: { type: DocType; key: string }) => api<PartnerProfile>('/partner/documents', { method: 'POST', body });
export const submitProfile = () => api<PartnerProfile>('/partner/submit', { method: 'POST' });

/** PUT the file to the presigned URL (not an API call). Sends exactly the signed headers (never Content-Length). */
export async function putToStorage(ticket: UploadTicket['upload'], file: Blob): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(ticket.headers ?? {})) {
    if (!['content-length', 'host'].includes(k.toLowerCase())) headers[k] = v;
  }
  const res = await fetch(ticket.url, { method: 'PUT', body: file, headers });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
}

// ---- availability + location
export const goOnline = (at: GeoPoint) => api<PartnerProfile>('/partner/online', { method: 'POST', body: at });
export const goOffline = () => api<PartnerProfile>('/partner/offline', { method: 'POST' });
export const postPartnerLocation = (p: GeoPoint & { accuracyM?: number }) =>
  api<{ at: string; jobsUpdated: number }>('/partner/location', { method: 'POST', body: p });

// ---- offers + deliveries
export const listOffers = () => api<{ items: Offer[] }>('/partner/offers');
export const acceptOffer = (offerId: string) => api<{ offerId: string; status: 'ACCEPTED'; job: PartnerJob }>(`/deliveries/offers/${offerId}/accept`, { method: 'POST' });
export const rejectOffer = (offerId: string) => api<unknown>(`/deliveries/offers/${offerId}/reject`, { method: 'POST' });
export const contactParty = (jobId: string, target: ContactTarget) =>
  api<ContactResult>(`/deliveries/${jobId}/contact`, { method: 'POST', body: { target } });
export const listActive = () => api<{ items: PartnerJob[] }>('/deliveries/active');
export const listHistory = (cursor?: string) => api<Paginated<PartnerJob>>('/deliveries/history', { query: { limit: 20, cursor } });
export const markArrived = (jobId: string) => api<PartnerJob>(`/deliveries/${jobId}/arrived`, { method: 'POST' });
export const confirmPickup = (jobId: string, code: string) => api<PartnerJob>(`/deliveries/${jobId}/pickup`, { method: 'POST', body: { code } });
export const startDelivery = (jobId: string) => api<PartnerJob>(`/deliveries/${jobId}/start`, { method: 'POST' });
export const confirmDelivered = (jobId: string, code: string) => api<PartnerJob>(`/deliveries/${jobId}/deliver`, { method: 'POST', body: { code } });
export const failDelivery = (jobId: string, reason: string) => api<PartnerJob>(`/deliveries/${jobId}/fail`, { method: 'POST', body: { reason } });

// ---- finance (services/payments)
/** Summary + PAY-1 window. No `from` = today in IST (server default). */
export const getSummary = (window?: { from?: string; to?: string }) =>
  api<FinanceSummary>('/finance/partner/summary', { query: { from: window?.from, to: window?.to } });
export const listLedger = (cursor?: string) => api<Paginated<LedgerEntry>>('/finance/partner/ledger', { query: { limit: 20, cursor } });
export const listPayouts = (cursor?: string, limit = 20) => api<Paginated<Payout>>('/finance/partner/payouts', { query: { limit, cursor } });

/** Google Maps directions link (format fixed by the product brief). */
export function navigationUrl(p: GeoPoint): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
}
