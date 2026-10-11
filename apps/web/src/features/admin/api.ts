/**
 * Admin API layer: typed wrappers over `api()` for every admin endpoint, plus small input helpers.
 * Shapes were read from the implemented service routes/schemas (redesign wave: ORD-1/2/7, DLV-4/5/7,
 * NTF-1/2/3, GW-1). All wrappers are thin so pages keep control of loading/error UX through TanStack Query.
 */
import { api } from '../../lib/api';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/* ------------------------------------------------------------------ query keys */
export const qk = {
  overview: (section: string) => ['admin', 'overview', section] as const,
  restaurants: (params: object) => ['admin', 'restaurants', params] as const,
  restaurant: (id: string) => ['admin', 'restaurant', id] as const,
  partners: (params: object) => ['admin', 'partners', params] as const,
  partner: (id: string) => ['admin', 'partner', id] as const,
  users: (params: object) => ['admin', 'users', params] as const,
  orders: (params: object) => ['admin', 'orders', params] as const,
  order: (id: string) => ['admin', 'order', id] as const,
  jobs: (params: object) => ['admin', 'tms', 'jobs', params] as const,
  tmsOverview: ['admin', 'tms', 'overview'] as const,
  catalog: (kind: string) => ['admin', 'catalog', kind] as const,
  tickets: (params: object) => ['admin', 'tickets', params] as const,
  ticket: (id: string) => ['admin', 'ticket', id] as const,
  refunds: (params: object) => ['admin', 'finance', 'refunds', params] as const,
  balances: (accountType: string) => ['admin', 'finance', 'balances', accountType] as const,
  payouts: (params: object) => ['admin', 'finance', 'payouts', params] as const,
  audit: (params: object) => ['admin', 'audit', params] as const,
  health: ['admin', 'health'] as const,
  deadLetters: ['admin', 'health', 'dead-letters'] as const,
  notifications: (params: object) => ['admin', 'health', 'notifications', params] as const,
  notificationSummary: ['admin', 'health', 'notification-summary'] as const,
  checkouts: (params: object) => ['admin', 'checkouts', params] as const,
  picker: (jobId: string) => ['admin', 'tms', 'picker', jobId] as const,
};

/* ------------------------------------------------------------------ input helpers */

/**
 * Rupee text ("12", "12.5", "1,200.50") to integer paise with string math (no floats).
 * Returns null for empty or invalid input (more than 2 decimals, negatives, junk).
 */
export function rupeesToPaise(input: string): number | null {
  const s = input.replace(/[,\s₹]/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}

/** Integer paise to an editable rupee string ("12.50", "12"). */
export function paiseToRupees(paise: number | null | undefined): string {
  if (paise === null || paise === undefined || !Number.isInteger(paise)) return '';
  const whole = Math.trunc(paise / 100);
  const frac = Math.abs(paise % 100);
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`;
}

const IST_OFFSET = '+05:30';
/** `datetime-local` value ("2026-10-10T18:30") interpreted as Asia/Kolkata, to an ISO instant. */
export function istInputToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const d = new Date(`${local}:00${IST_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/** ISO instant to a `datetime-local` value in Asia/Kolkata. */
export function isoToIstInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const shifted = new Date(d.getTime() + 330 * 60_000);
  return shifted.toISOString().slice(0, 16);
}
/**
 * Calendar date ("2026-10-10") in IST to an instant. `start` = 00:00 that day; `end` = the start of the
 * NEXT day minus 1 ms (inclusive upper bound that includes the whole day, seconds and milliseconds).
 */
export function istDateToIso(date: string, edge: 'start' | 'end'): string | undefined {
  const start = istInputToIso(`${date}T00:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !start) return undefined;
  return edge === 'start' ? start : new Date(new Date(start).getTime() + 86_400_000 - 1).toISOString();
}

/* ------------------------------------------------------------------ restaurants (VERIFIED: services/marketplace admin-restaurants) */
export type RestaurantStatusValue = 'DRAFT' | 'VERIFICATION_PENDING' | 'APPROVAL_PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

export interface AdminRestaurantDoc {
  id: string;
  type: string;
  key: string;
  verified: boolean;
  uploadedAt: string | null;
}
export interface AdminRestaurant {
  id: string;
  ownerUserId: string;
  status: RestaurantStatusValue;
  statusReason: string | null;
  statusHistory: { from: string; to: string; actorId: string; reason: string | null; at: string }[];
  businessName: string | null;
  name: string;
  slug: string;
  description: string | null;
  cuisines: string[];
  phone: string | null;
  businessEmail: string | null;
  emailVerified: boolean;
  emailVerifiedAt: string | null;
  address: { line1: string; line2?: string; city: string; pincode: string } | null;
  location: { lat: number; lng: number } | null;
  documents: AdminRestaurantDoc[];
  settlement: { accountHolder: string; ifsc: string; last4: string } | null;
  commissionBps: number;
  avgPrepMinutes: number;
  isDemo: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export const listRestaurants = (p: { status?: string; q?: string; cursor?: string; limit?: number }) =>
  api<Page<AdminRestaurant>>('/admin/marketplace/restaurants', { query: { limit: 20, ...p } });
export const getRestaurant = (id: string) => api<AdminRestaurant>(`/admin/marketplace/restaurants/${encodeURIComponent(id)}`);
export type ApprovalAction = 'approve' | 'reject' | 'suspend' | 'reinstate';
export const restaurantAction = (id: string, action: ApprovalAction, reason?: string) =>
  api<AdminRestaurant>(`/admin/marketplace/restaurants/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    body: reason ? { reason } : {},
  });
export interface SignedUrl {
  url: string;
  expiresAt: string;
  type?: string;
  demoVerified?: boolean;
}
export const restaurantDocumentUrl = (id: string, docId: string) =>
  api<SignedUrl>(`/admin/marketplace/restaurants/${encodeURIComponent(id)}/documents/${encodeURIComponent(docId)}/url`);
export const verifyRestaurantDocument = (id: string, docId: string) =>
  api<AdminRestaurantDoc>(`/admin/marketplace/restaurants/${encodeURIComponent(id)}/documents/${encodeURIComponent(docId)}/verify`, { method: 'POST' });

/* ------------------------------------------------------------------ partners (VERIFIED: services/delivery admin-delivery) */
export interface AdminPartner {
  id: string;
  userId: string;
  name: string;
  phone: string | null;
  vehicle: { type: string; registrationNumber: string } | null;
  status: 'DRAFT' | 'APPROVAL_PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  statusReason: string | null;
  documents: { id: string; type: string; demoVerified: boolean; uploadedAt: string | null }[];
  online: boolean;
  lastLocation: { lat: number; lng: number } | null;
  lastLocationAt: string | null;
  activeJobIds: string[];
  maxActive: number;
  isDemo: boolean;
  createdAt: string | null;
}
/** DLV-7 picker rows: `distanceToPickupKm` is set only with `nearJobId`. */
export interface AdminPartnerRow extends AdminPartner {
  distanceToPickupKm?: number | null;
  activeJobCount?: number;
}
export interface PartnerListParams {
  status?: string;
  cursor?: string;
  limit?: number;
  online?: boolean;
  hasCapacity?: boolean;
  /** Sort by distance to this job's pickup (no cursor; partners without a location are left out). */
  nearJobId?: string;
}
const flag = (v: boolean | undefined) => (v === undefined ? undefined : String(v));
export const listPartners = (p: PartnerListParams) =>
  api<Page<AdminPartnerRow>>('/admin/delivery/partners', {
    query: { limit: 20, ...p, online: flag(p.online), hasCapacity: flag(p.hasCapacity) },
  });
/** There is no `GET /admin/delivery/partners/:id`; scan the list (bounded) for the partner. */
export async function findPartner(id: string): Promise<AdminPartner> {
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await listPartners({ limit: 100, cursor });
    const hit = page.items.find((p) => p.id === id);
    if (hit) return hit;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const { ApiError } = await import('../../lib/errors');
  throw new ApiError({ code: 'NOT_FOUND', status: 404, message: 'Partner not found' });
}
export const partnerAction = (id: string, action: ApprovalAction, reason?: string) =>
  api<AdminPartner>(`/admin/delivery/partners/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: reason ? { reason } : {} });
export const partnerDocumentUrl = (id: string, docId: string) =>
  api<SignedUrl>(`/admin/delivery/partners/${encodeURIComponent(id)}/documents/${encodeURIComponent(docId)}/url`);

/* ------------------------------------------------------------------ users (VERIFIED: services/identity admin-users) */
export interface AdminUser {
  id: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  roles: string[];
  adminRoles: string[];
  status: 'ACTIVE' | 'BLOCKED';
  addresses: unknown[];
  createdAt: string;
}
export const listUsers = (p: { q?: string; role?: string; status?: string; cursor?: string; limit?: number }) =>
  api<Page<AdminUser>>('/admin/users', { query: { limit: 20, ...p } });
export const setUserBlocked = (id: string, blocked: boolean, reason?: string) =>
  api<AdminUser>(`/admin/users/${encodeURIComponent(id)}/${blocked ? 'block' : 'unblock'}`, { method: 'POST', body: reason ? { reason } : {} });
export const createAdminUser = (body: { email: string; name: string; adminRoles: string[] }) =>
  api<{ user: AdminUser; oneTimePassword: string }>('/admin/admins', { method: 'POST', body });

/* ------------------------------------------------------------------ audit (VERIFIED: services/identity audit) */
export interface AuditLog {
  id: string;
  eventId: string;
  actorId: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  summary: string;
  ip: string | null;
  correlationId: string;
  service: string;
  occurredAt: string;
}
export const listAuditLogs = (p: Record<string, string | number | undefined>) =>
  api<Page<AuditLog>>('/admin/audit-logs', { query: { limit: 25, ...p } });

/* ------------------------------------------------------------------ delivery / TMS (VERIFIED: services/delivery tms + views) */
export type DeliveryStatusValue =
  | 'PENDING_ASSIGNMENT' | 'OFFERED' | 'ASSIGNED' | 'AT_PICKUP' | 'PICKED_UP' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'FAILED' | 'CANCELLED';
export interface AdminJob {
  id: string;
  childOrderId: string;
  checkoutGroupId: string;
  restaurantId: string;
  customerUserId: string;
  status: DeliveryStatusValue;
  partnerId: string | null;
  partnerUserId: string | null;
  /** DLV-4: order codes on the job (null for jobs the backfill has not reached). */
  childOrderCode?: string | null;
  checkoutCode?: string | null;
  pickup: { name: string; address: string; location: { lat: number; lng: number } };
  drop: { name: string; address: string; area?: string | null; label?: string | null; phoneMasked?: string; location: { lat: number; lng: number } };
  dispatchRound: number;
  exception: boolean;
  exceptionReason: string | null;
  distanceKm: number;
  estimatedMinutes: number;
  estimateSource: string;
  readyAt: string | null;
  failureReason: string | null;
  lastLocationAt: string | null;
  locationSimulated: boolean;
  statusHistory: { from: string | null; to: string; at: string | null; actor: string; actorId: string | null; reason: string | null }[];
  assignedAt: string | null;
  createdAt: string | null;
}
export interface TmsOverview {
  jobsByStatus: Record<string, number>;
  /** DLV-5: PENDING_ASSIGNMENT + OFFERED. */
  unassigned?: number;
  exceptions: number;
  liveOffers: number;
  /** DLV-5: `approved`, `onDelivery` (approved ∧ online ∧ holding an active job). */
  partners: { byStatus: Record<string, number>; online: number; approved?: number; onDelivery?: number };
  generatedAt: string;
}
export const listJobs = (p: { status?: string; exception?: boolean; q?: string; cursor?: string; limit?: number }) =>
  api<Page<AdminJob>>('/admin/delivery/jobs', { query: { limit: 20, ...p, exception: p.exception === undefined ? undefined : String(p.exception) } });
export const tmsOverview = () => api<TmsOverview>('/admin/delivery/overview');
export const assignJob = (jobId: string, partnerId: string) =>
  api<AdminJob>(`/admin/delivery/jobs/${encodeURIComponent(jobId)}/assign`, { method: 'POST', body: { partnerId } });
export const unassignJob = (jobId: string, reason?: string) =>
  api<AdminJob>(`/admin/delivery/jobs/${encodeURIComponent(jobId)}/unassign`, { method: 'POST', body: reason ? { reason } : {} });
export const failJob = (jobId: string, reason: string) =>
  api<AdminJob>(`/admin/delivery/jobs/${encodeURIComponent(jobId)}/fail`, { method: 'POST', body: { reason } });
export const simulateJob = (jobId: string) =>
  api<{ jobId: string; steps: number; stepMs: number; simulated: true }>(`/admin/delivery/demo/simulate/${encodeURIComponent(jobId)}`, { method: 'POST' });

/* ------------------------------------------------------------------ catalog (all five kinds VERIFIED against services/marketplace) */
export interface Cuisine { id: string; name: string; slug: string; imageKey: string | null; imageUrl: string | null; sortOrder: number; active: boolean }
export interface Banner {
  id: string; title: string; imageKey: string; imageUrl: string; linkType: 'RESTAURANT' | 'CUISINE' | 'COUPON'; linkValue: string;
  activeFrom: string; activeTo: string; active: boolean; isDemo: boolean;
}
export interface FeeRule { basePaise: number; baseKm: number; perKmPaise: number; maxPaise: number }
export interface ServiceArea {
  id: string; name: string; polygon: { type: 'Polygon'; coordinates: number[][][] }; active: boolean; deliveryFee: FeeRule; minOrderPaise: number;
}
/** VERIFIED: services/marketplace admin-promotions `AdminCoupon`. */
export interface Coupon {
  id: string; code: string; description: string; type: 'FLAT' | 'PERCENT'; valuePaise: number | null; valueBps: number | null;
  maxDiscountPaise: number | null; minOrderPaise: number; validFrom: string; validTo: string; totalLimit: number | null;
  perUserLimit: number | null; usedCount: number; heldCount: number; active: boolean; firstOrderOnly: boolean;
}
/** VERIFIED: services/marketplace admin-promotions plans (`terms` is required, 1-20000 chars). */
export interface MembershipPlan {
  id: string; name: string; pricePaise: number; durationDays: number; terms?: string | null; active: boolean;
  benefits: { freeDeliveryMinOrderPaise?: number; freeDeliveriesPerPeriod?: number; extraDiscountBps?: number; extraDiscountCapPaise?: number };
}
export type CatalogKind = 'coupons' | 'banners' | 'cuisines' | 'plans' | 'service-areas';
const catalogPath = (kind: CatalogKind) => `/admin/marketplace/${kind}`;
export const listCatalog = <T,>(kind: CatalogKind) => api<{ items: T[] }>(catalogPath(kind));
export const createCatalog = <T,>(kind: CatalogKind, body: unknown) => api<T>(catalogPath(kind), { method: 'POST', body });
export const updateCatalog = <T,>(kind: CatalogKind, id: string, body: unknown) =>
  api<T>(`${catalogPath(kind)}/${encodeURIComponent(id)}`, { method: 'PATCH', body });
export const deleteCatalog = (kind: CatalogKind, id: string) => api<void>(`${catalogPath(kind)}/${encodeURIComponent(id)}`, { method: 'DELETE' });

export interface Presign {
  key: string;
  bucket: string;
  upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string; maxBytes: number };
}
/** Presign + PUT the file to storage (plain fetch, not the API); resolves to the object key to save. */
export async function uploadCatalogImage(file: File): Promise<string> {
  const presign = await api<Presign>('/admin/marketplace/uploads', { method: 'POST', body: { contentType: file.type, sizeBytes: file.size } });
  const res = await fetch(presign.upload.url, { method: 'PUT', body: file, headers: { ...presign.upload.headers, 'Content-Type': file.type } });
  if (!res.ok) {
    const { ApiError } = await import('../../lib/errors');
    throw new ApiError({ code: 'UPLOAD_FAILED', status: res.status, message: `Image upload failed (${res.status}). Try again.` });
  }
  return presign.key;
}

/* ------------------------------------------------------------------ overview (delivery + marketplace VERIFIED; orders UNVERIFIED) */
export type OverviewData = Record<string, unknown>;
export interface MarketplaceOverview {
  generatedAt: string;
  restaurants: { total: number; byStatus: Record<string, number>; pendingApproval: number; pendingVerification: number };
  coupons: { total: number; active: number; redeemed: number; redeemedDiscountPaise: number; held: number };
  memberships: { active: number; pendingPayment: number; byStatus: Record<string, number> };
  reservations: { held: number };
  ratings: { total: number };
  menu: { items: number };
}
export const marketplaceOverview = () => api<MarketplaceOverview>('/admin/marketplace/overview');

/** VERIFIED: services/orders domain/stats.ts `ordersOverview` (ORD-2; "today" = since IST midnight). */
export interface OrdersOverview {
  generatedAt: string;
  today: {
    since: string;
    /** Checkouts placed today. */
    checkouts: number;
    /** Child orders placed today. */
    placed: number;
    delivered: number;
    rejected: number;
    cancelled: number;
    gmvPaise: number;
    /** Children placed today by their CURRENT status (all 13 keys). */
    byStatus: Record<string, number>;
    /** Refund entries that succeeded today. */
    refundedPaise: number;
  };
  activeByStatus: Record<string, number>;
  awaitingAcceptance: number;
  overdueAcceptance: number;
  deliveryFailed: number;
  refundsPending: number;
  /** All-time Σ (requested − refunded) over pending refunds. */
  refundsPendingPaise: number;
  refundsFailed: number;
  support: { open: number; inProgress: number };
}
export const ordersOverview = () => api<OrdersOverview>('/admin/orders/overview');

/* ------------------------------------------------------------------ checkouts list (VERIFIED: ORD-1 order-schemas AdminCheckoutRow) */
export type CheckoutAttention = 'DELIVERY_FAILED' | 'REFUND_FAILED' | 'FINDING_PARTNER' | 'AWAITING_ACCEPTANCE';
export interface AdminCheckoutRow {
  id: string;
  code: string;
  status: string;
  userId: string;
  placedAt: string | null;
  createdAt: string | null;
  customer: { name: string | null; phoneMasked: string | null } | null;
  restaurants: { id: string; childOrderId: string; childCode: string; name: string; childStatus: string; deliveryStatus: string | null; refundStatus: string }[];
  totalPaise: number;
  paidPaise: number;
  refundedPaise: number;
  refundPendingPaise: number;
  attention: CheckoutAttention | null;
}
export interface CheckoutListParams {
  /** TH- code, ids, restaurant-name prefix, or 4–13 digits (phone last-4 search, ORD-7). */
  q?: string;
  /** CSV of checkout statuses. */
  status?: string;
  phone?: string;
  restaurantId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}
export const listCheckouts = (p: CheckoutListParams) => api<Page<AdminCheckoutRow>>('/admin/orders/checkouts', { query: { limit: 20, ...p } });

/* ------------------------------------------------------------------ order detail (VERIFIED: orders order-views adminOrderDetail) */
export interface AdminChildOrder {
  id: string;
  code?: string;
  restaurantId?: string;
  restaurantName: string;
  status: string;
  totalPaise: number;
  refundedPaise: number;
  /** Paise orders has asked payments to refund for this child (server `refundRequestedPaise`). */
  refundRequestedPaise: number;
  /** Refunds seen from payments; non-FAILED ones count as committed (server `committedRefundPaise`). */
  refunds: { refundId: string; amountPaise: number; status: string }[];
  refundStatus: string;
  deliveryStatus: string | null;
  lines: { name: string; quantity: number; lineTotalPaise?: number }[];
}
export interface TimelineEntry {
  id: string;
  type: string;
  childOrderId: string | null;
  actor: string;
  actorId: string | null;
  at: string;
  data: Record<string, unknown>;
}
export interface AdminOrderDetail {
  id: string;
  code: string;
  status: string;
  paymentStatus: string | null;
  paymentIntentId: string | null;
  totalPaise: number | null;
  createdAt: string | null;
  customer: { id?: string; name?: string | null; phone?: string | null } | null;
  deliveryAddress: string | null;
  children: AdminChildOrder[];
  timeline: TimelineEntry[];
}
export interface AdminOrderSummary {
  id: string;
  code: string;
  status: string;
  totalPaise: number | null;
  createdAt: string | null;
  customerLabel: string;
  restaurants: string[];
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const numOr = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function normalizeChild(raw: unknown): AdminChildOrder {
  const c = rec(raw);
  const breakdown = rec(c.breakdown);
  return {
    id: String(c.id ?? c._id ?? ''),
    code: str(c.code) ?? undefined,
    restaurantId: str(c.restaurantId) ?? undefined,
    restaurantName: str(c.restaurantName) ?? 'Restaurant',
    status: str(c.status) ?? 'UNKNOWN',
    totalPaise: numOr(c.totalPaise, numOr(breakdown.totalPaise, 0)),
    refundedPaise: numOr(c.refundedPaise, 0),
    refundRequestedPaise: numOr(c.refundRequestedPaise, 0),
    refunds: Array.isArray(c.refunds)
      ? c.refunds.map((r) => {
          const o = rec(r);
          return { refundId: String(o.refundId ?? ''), amountPaise: numOr(o.amountPaise, 0), status: str(o.status) ?? 'REQUESTED' };
        })
      : [],
    refundStatus: str(c.refundStatus) ?? 'NONE',
    deliveryStatus: str(c.deliveryStatus),
    lines: Array.isArray(c.lines)
      ? c.lines.map((l) => {
          const o = rec(l);
          return { name: str(o.name) ?? 'Item', quantity: numOr(o.quantity, 1), lineTotalPaise: typeof o.lineTotalPaise === 'number' ? o.lineTotalPaise : undefined };
        })
      : [],
  };
}

export function normalizeOrderDetail(raw: unknown): AdminOrderDetail {
  const top = rec(raw);
  const group = rec(top.checkout ?? top.group ?? top);
  const pricing = rec(group.pricing);
  const childrenRaw = top.children ?? top.childOrders ?? group.children ?? [];
  const timelineRaw = top.timeline ?? top.events ?? group.timeline ?? [];
  const customer = rec(top.customer ?? group.customer ?? top.user);
  const address = rec(group.deliveryAddress);
  return {
    id: String(group.id ?? group._id ?? ''),
    code: str(group.code) ?? String(group.id ?? ''),
    status: str(group.status) ?? 'UNKNOWN',
    paymentStatus: str(group.paymentStatus),
    paymentIntentId: str(group.paymentIntentId ?? rec(top.payment).intentId ?? rec(top.payment).paymentIntentId),
    totalPaise: typeof pricing.totalPaise === 'number' ? pricing.totalPaise : null,
    createdAt: str(group.createdAt),
    customer: Object.keys(customer).length
      ? { id: str(customer.id) ?? undefined, name: str(customer.name), phone: str(customer.phone ?? customer.phoneMasked) }
      : null,
    deliveryAddress: [address.line1, address.line2, address.city, address.pincode].filter((x) => typeof x === 'string' && x).join(', ') || null,
    children: (Array.isArray(childrenRaw) ? childrenRaw : []).map(normalizeChild),
    timeline: (Array.isArray(timelineRaw) ? timelineRaw : []).map((e, i) => {
      const o = rec(e);
      return {
        id: String(o.id ?? o._id ?? i),
        type: str(o.type) ?? 'event',
        childOrderId: str(o.childOrderId),
        actor: str(o.actor) ?? 'SYSTEM',
        actorId: str(o.actorId),
        at: str(o.at) ?? '',
        data: rec(o.data),
      };
    }),
  };
}

export function normalizeOrderSummary(raw: unknown): AdminOrderSummary {
  const o = rec(raw);
  const pricing = rec(o.pricing);
  const customer = rec(o.customer ?? o.user);
  const children = Array.isArray(o.children) ? o.children : [];
  return {
    id: String(o.id ?? o._id ?? o.checkoutId ?? ''),
    code: str(o.code) ?? String(o.id ?? ''),
    status: str(o.status) ?? 'UNKNOWN',
    totalPaise: typeof o.totalPaise === 'number' ? o.totalPaise : typeof pricing.totalPaise === 'number' ? pricing.totalPaise : null,
    createdAt: str(o.createdAt),
    customerLabel: str(customer.phone) ?? str(customer.name) ?? str(o.customerPhone) ?? str(o.userId) ?? '',
    restaurants: children.map((c) => str(rec(c).restaurantName)).filter((x): x is string => !!x),
  };
}

export const searchOrders = async (p: Record<string, string | number | undefined>): Promise<Page<AdminOrderSummary>> => {
  const res = await api<{ items: unknown[]; nextCursor?: string | null }>('/admin/orders', { query: { limit: 20, ...p } });
  return { items: (res.items ?? []).map(normalizeOrderSummary), nextCursor: res.nextCursor ?? null };
};
export const getOrder = async (id: string) => normalizeOrderDetail(await api<unknown>(`/admin/orders/${encodeURIComponent(id)}`));
export const cancelChildOrder = (childId: string, body: { reason: string; refundPaise: number }) =>
  api(`/admin/orders/child/${encodeURIComponent(childId)}/cancel`, { method: 'POST', body });
export const transitionChildOrder = (childId: string, body: { to: string; reason: string }) =>
  api(`/admin/orders/child/${encodeURIComponent(childId)}/transition`, { method: 'POST', body });

/* ------------------------------------------------------------------ support (services/orders admin-support) */
export interface TicketMessage { authorId: string; authorRole: string; body: string; at: string }
export interface Ticket {
  id: string;
  code: string;
  userId?: string;
  childOrderId?: string | null;
  checkoutGroupId?: string | null;
  subject: string;
  category: string;
  status: string;
  priority?: string | null;
  assigneeId?: string | null;
  messages: TicketMessage[];
  createdAt: string;
  updatedAt?: string;
}
export const listTickets = (p: { status?: string; cursor?: string; limit?: number }) =>
  api<Page<Ticket>>('/admin/support/tickets', { query: { limit: 20, ...p } });
export const getTicket = (id: string) => api<Ticket>(`/admin/support/tickets/${encodeURIComponent(id)}`);
export const patchTicket = (id: string, body: { status?: string; assigneeId?: string | null; priority?: string }) =>
  api<Ticket>(`/admin/support/tickets/${encodeURIComponent(id)}`, { method: 'PATCH', body });
export const replyTicket = (id: string, body: string) =>
  api<Ticket>(`/admin/support/tickets/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { body } });

/* ------------------------------------------------------------------ finance (VERIFIED: services/payments admin-finance) */
export interface Refund {
  id: string;
  paymentIntentId: string;
  checkoutGroupId: string;
  childOrderId: string | null;
  restaurantId: string | null;
  amountPaise: number;
  reason: string;
  status: 'REQUESTED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  providerRefundId: string | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  requestedBy: string;
  note: string | null;
  chargeRestaurantPaise: number;
  createdAt: string;
  updatedAt: string;
}
export const listRefunds = (p: { status?: string; cursor?: string; limit?: number }) =>
  api<Page<Refund>>('/admin/finance/refunds', { query: { limit: 20, ...p } });
export const retryRefund = (id: string) => api<Refund>(`/admin/finance/refunds/${encodeURIComponent(id)}/retry`, { method: 'POST' });
export interface ManualRefundBody {
  paymentIntentId: string;
  amountPaise: number;
  reason: 'ADMIN' | 'DELIVERY_FAILED' | 'CUSTOMER_CANCELLED';
  note: string;
  childOrderId?: string;
  restaurantId?: string;
  chargeRestaurantPaise?: number;
}
export const createManualRefund = (body: ManualRefundBody, idempotencyKey: string) =>
  api<Refund>('/admin/finance/refunds', { method: 'POST', body, idempotencyKey });
export interface PaymentRow {
  paymentIntentId: string;
  status: string;
  purpose: string;
  referenceId: string;
  amountPaise: number;
  capturedPaise: number;
  refundedPaise: number;
  refundReservedPaise: number;
  userId: string;
  isDemo: boolean;
  createdAt: string;
}
export const searchPayments = (q: string, limit = 5) => api<Page<PaymentRow>>('/admin/finance/payments', { query: { q, limit } });

export interface Balance {
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
export const listBalances = (accountType: string, cursor?: string) =>
  api<Page<Balance>>('/admin/finance/balances', { query: { accountType, limit: 50, cursor } });

export interface Payout {
  id: string;
  accountType: 'RESTAURANT' | 'PARTNER';
  accountId: string;
  amountPaise: number;
  status: 'REQUESTED' | 'PROCESSING' | 'PAID' | 'FAILED' | 'CANCELLED';
  method: string;
  utr: string | null;
  requestedBy: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  failureReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}
export const listPayouts = (p: { status?: string; accountType?: string; cursor?: string; limit?: number }) =>
  api<Page<Payout>>('/admin/finance/payouts', { query: { limit: 20, ...p } });
export const createPayout = (body: { accountType: string; accountId: string; amountPaise: number; notes?: string }, idempotencyKey: string) =>
  api<Payout>('/admin/finance/payouts', { method: 'POST', body, idempotencyKey });
export const confirmPayout = (id: string, utr: string) =>
  api<Payout>(`/admin/finance/payouts/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: { utr } });
export const failPayout = (id: string, reason: string) =>
  api<Payout>(`/admin/finance/payouts/${encodeURIComponent(id)}/fail`, { method: 'POST', body: { reason } });
/** UTR rule from the server: 6-32 letters/digits. */
export const UTR_PATTERN = /^[A-Za-z0-9]{6,32}$/;

/* ------------------------------------------------------------------ health (VERIFIED: services/gateway health.ts, service-kit health-details) */
export type HealthState = 'up' | 'degraded' | 'down';
export interface ServiceHealth {
  status: HealthState;
  latencyMs: number;
  /** GW-1: why the service is degraded (empty when up or down). */
  degradedReasons?: string[];
  /** GW-1: one line for the health row ("All checks passing", "Unreachable: …", reasons). */
  summary?: string;
  /** GW-1: provider category → up | failing. A failing provider makes the service Degraded, never Down. */
  providers?: Record<string, 'up' | 'failing'>;
  details?: {
    service?: string;
    mode?: string;
    mongo?: 'up' | 'down';
    redis?: 'up' | 'down';
    outboxPending?: number | null;
    outboxOldestAgeSec?: number | null;
    consumerLag?: Record<string, number | null>;
    deadLetters?: number | null;
    providerErrorsLastHour?: number | null;
    providerErrorsByProvider?: Record<string, number> | null;
    checkedAt?: string;
    [k: string]: unknown;
  };
  error?: string;
  errorCode?: string;
}
export interface HealthReport {
  checkedAt: string;
  overall: HealthState;
  gateway: { status: 'up' | 'degraded'; mode: string; redis: 'up' | 'down' };
  services: Record<string, ServiceHealth>;
}
export const getHealth = () => api<HealthReport>('/admin/health');

export interface DeadLetter {
  id: string;
  stream: string;
  entryId: string;
  service: string;
  envelope: unknown;
  error: string;
  attempts: number;
  failedAt: string;
  replayedAt: string | null;
  replayCount: number;
}
export interface DeadLettersResponse {
  items: DeadLetter[];
  errors: { service: string; code: string; message: string }[];
  sources: string[];
}
export const listDeadLetters = () => api<DeadLettersResponse>('/admin/notifications/dead-letters', { query: { limit: 50 } });
export const replayDeadLetter = (service: string, id: string) =>
  api<{ id: string }>(`/admin/notifications/dead-letters/${encodeURIComponent(service)}/${encodeURIComponent(id)}/replay`, { method: 'POST' });
/** NTF-3: replay every unreplayed dead letter (optionally one service), oldest first. */
export interface BulkReplayResult {
  replayed: number;
  failed: { service: string; id: string; error: string }[];
}
export const replayAllDeadLetters = (body: { service?: string; limit?: number } = {}) =>
  api<BulkReplayResult>('/admin/notifications/dead-letters/replay', { method: 'POST', body });

export interface AdminNotification {
  id: string;
  userId: string | null;
  channel: 'SMS' | 'EMAIL' | 'IN_APP';
  to: string;
  template: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  provider: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
export const listNotifications = (p: { status?: string; channel?: string; cursor?: string; limit?: number }) =>
  api<Page<AdminNotification>>('/admin/notifications', { query: { limit: 20, ...p } });
export const retryNotification = (id: string) => api<AdminNotification>(`/admin/notifications/${encodeURIComponent(id)}/retry`, { method: 'POST' });

/** NTF-1 (VERIFIED: notifications routes/admin.ts `/summary`). `byStatus` is all-time. */
export interface NotificationSummary {
  byStatus: Record<'QUEUED' | 'SENDING' | 'SENT' | 'DELIVERED' | 'FAILED' | 'DEAD' | 'SKIPPED', number>;
  failedLast24h: number;
  byChannel: { SMS: { failed: number }; EMAIL: { failed: number } };
  lastError: { channel: string; provider: string | null; message: string; at: string } | null;
}
const NTF_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'DEAD', 'SKIPPED'] as const;
/** Fills missing keys with 0 so a partial payload never renders as a crash (or as invented numbers: absent = 0 rows). */
export function normalizeNotificationSummary(raw: unknown): NotificationSummary {
  const r = rec(raw);
  const by = rec(r.byStatus);
  const ch = rec(r.byChannel);
  const last = rec(r.lastError);
  return {
    byStatus: Object.fromEntries(NTF_STATUSES.map((k) => [k, numOr(by[k], 0)])) as NotificationSummary['byStatus'],
    failedLast24h: numOr(r.failedLast24h, 0),
    byChannel: { SMS: { failed: numOr(rec(ch.SMS).failed, 0) }, EMAIL: { failed: numOr(rec(ch.EMAIL).failed, 0) } },
    lastError: str(last.message) ? { channel: str(last.channel) ?? '', provider: str(last.provider), message: str(last.message)!, at: str(last.at) ?? '' } : null,
  };
}
export const notificationSummary = async () => {
  const raw = await api<unknown>('/admin/notifications/summary');
  if (!raw || typeof raw !== 'object' || !('byStatus' in raw)) {
    const { ApiError } = await import('../../lib/errors');
    throw new ApiError({ code: 'UPSTREAM_ERROR', status: 502, message: 'Notification summary is unavailable' });
  }
  return normalizeNotificationSummary(raw);
};
/** The admin "N failed notifications" figure: every retryable notification (FAILED + DEAD, all time). */
export const retryableCount = (s: NotificationSummary | undefined) => (s ? (s.byStatus.FAILED ?? 0) + (s.byStatus.DEAD ?? 0) : 0);
/** NTF-2: re-queue every FAILED or DEAD notification (never OTP). */
export const retryAllNotifications = (body: { status: 'FAILED' | 'DEAD'; channel?: 'SMS' | 'EMAIL' | 'IN_APP'; before?: string; limit?: number }) =>
  api<{ queued: number }>('/admin/notifications/retry', { method: 'POST', body });

/** Unreplayed dead letters across services, from the health report (`details.deadLetters`). */
export function deadLetterCount(report: HealthReport | undefined): number {
  if (!report) return 0;
  return Object.values(report.services).reduce((n, s) => n + (typeof s.details?.deadLetters === 'number' ? s.details.deadLetters : 0), 0);
}
export const setFailMode = (body: { sms: boolean; email: boolean }) =>
  api<{ sms: boolean; email: boolean }>('/admin/notifications/demo/fail-mode', { method: 'POST', body });
