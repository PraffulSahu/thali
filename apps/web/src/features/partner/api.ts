/**
 * Partner API: types (mirroring services/delivery + services/payments zod views) and thin fetchers.
 * Money is integer paise. Paths are relative to /api/v1 (see lib/api.ts).
 */
import type { GeoPoint, Paginated } from '@thali/contracts';
import { api } from '../../lib/api';

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
export interface DropPlace extends Place {
  phoneMasked: string;
}

export interface PartnerJob {
  id: string;
  childOrderId: string;
  status: DeliveryStatusValue;
  pickup: Place;
  drop: DropPlace;
  distanceKm: number;
  estimatedMinutes: number;
  estimateSource: string;
  prepMinutes: number | null;
  readyEta: string | null;
  readyAt: string | null;
  codeAttemptsRemaining: number;
  navigation: { pickupUrl: string; dropUrl: string };
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
    drop: Place;
    distanceKm: number;
    estimatedMinutes: number;
    estimateSource: string;
    readyEta: string | null;
  } | null;
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
  summary: ['partner', 'finance', 'summary'] as const,
  ledger: (cursor?: string) => ['partner', 'finance', 'ledger', cursor ?? null] as const,
  payouts: (cursor?: string) => ['partner', 'finance', 'payouts', cursor ?? null] as const,
};

// ---- onboarding
export const getProfile = (signal?: AbortSignal) => api<PartnerProfile>('/partner/profile', { signal });
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
export const postJobLocation = (jobId: string, p: GeoPoint & { accuracyM?: number }) =>
  api<{ at: string; jobsUpdated: number }>(`/deliveries/${jobId}/location`, { method: 'POST', body: p });

// ---- offers + deliveries
export const listOffers = () => api<{ items: Offer[] }>('/partner/offers');
export const acceptOffer = (offerId: string) => api<{ offerId: string; status: 'ACCEPTED'; job: PartnerJob }>(`/deliveries/offers/${offerId}/accept`, { method: 'POST' });
export const rejectOffer = (offerId: string) => api<unknown>(`/deliveries/offers/${offerId}/reject`, { method: 'POST' });
export const listActive = () => api<{ items: PartnerJob[] }>('/deliveries/active');
export const listHistory = (cursor?: string) => api<Paginated<PartnerJob>>('/deliveries/history', { query: { limit: 20, cursor } });
export const markArrived = (jobId: string) => api<PartnerJob>(`/deliveries/${jobId}/arrived`, { method: 'POST' });
export const confirmPickup = (jobId: string, code: string) => api<PartnerJob>(`/deliveries/${jobId}/pickup`, { method: 'POST', body: { code } });
export const startDelivery = (jobId: string) => api<PartnerJob>(`/deliveries/${jobId}/start`, { method: 'POST' });
export const confirmDelivered = (jobId: string, code: string) => api<PartnerJob>(`/deliveries/${jobId}/deliver`, { method: 'POST', body: { code } });
export const failDelivery = (jobId: string, reason: string) => api<PartnerJob>(`/deliveries/${jobId}/fail`, { method: 'POST', body: { reason } });

// ---- finance (services/payments)
export const getSummary = () => api<FinanceSummary>('/finance/partner/summary');
export const listLedger = (cursor?: string) => api<Paginated<LedgerEntry>>('/finance/partner/ledger', { query: { limit: 20, cursor } });
export const listPayouts = (cursor?: string) => api<Paginated<Payout>>('/finance/partner/payouts', { query: { limit: 20, cursor } });

/** Google Maps directions link (format fixed by the product brief). */
export function navigationUrl(p: GeoPoint): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
}
