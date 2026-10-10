/**
 * Restaurant-area API layer: types, fetchers, query keys, upload helper and small pure helpers.
 *
 * Verified against the implemented marketplace service (owner-restaurants, owner-menu, uploads) and the
 * payments service (finance). Owner order routes (orders Task 12) and the owner dashboard (marketplace) were
 * not written when this was built: those shapes follow LLD section 10 and are normalised defensively
 * (see the "Unverified" markers below and the Task 18 report).
 */
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { ChildOrderStatus, HoursSlot, LedgerEntryType, PayoutStatus, RestaurantStatus } from '@thali/contracts';
import { api, type Paginated } from '../../lib/api';

/* ------------------------------------------------------------------ restaurant */

export interface OwnerRestaurant {
  id: string;
  ownerUserId: string;
  status: RestaurantStatus;
  statusReason: string | null;
  statusHistory: { from: string; to: string; actorId: string; reason: string | null; at: string | null }[];
  businessName: string | null;
  name: string;
  slug: string;
  description: string | null;
  cuisines: string[];
  phone: string | null;
  businessEmail: string | null;
  emailVerified: boolean;
  emailVerifiedAt: string | null;
  emailVerification: { sentAt: string | null; expiresAt: string | null } | null;
  address: { line1: string; line2?: string; city: string; pincode: string } | null;
  location: { lat: number; lng: number } | null;
  deliveryRadiusKm: number;
  hours: HoursSlot[];
  timezone: string;
  pausedUntil: string | null;
  images: { cover: string | null; logo: string | null; coverUrl: string | null; logoUrl: string | null };
  documents: { id: string; type: string; key: string; verified: boolean; uploadedAt: string | null }[];
  settlement: { accountHolder: string; ifsc: string; last4: string } | null;
  packagingFeePaise: number;
  avgPrepMinutes: number;
  commissionBps: number;
  rating: { average: number; count: number } | null;
  isDemo: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export type RestaurantPatch = Partial<{
  businessName: string;
  name: string;
  description: string;
  cuisines: string[];
  phone: string;
  businessEmail: string;
  address: { line1: string; line2?: string; city: string; pincode: string };
  location: { lat: number; lng: number };
  deliveryRadiusKm: number;
  packagingFeePaise: number;
  avgPrepMinutes: number;
  images: { cover?: string | null; logo?: string | null };
}>;

export const keys = {
  restaurants: ['owner', 'restaurants'] as const,
  restaurant: (id: string) => ['owner', 'restaurant', id] as const,
  cuisines: ['meta', 'cuisines'] as const,
  categories: (id: string) => ['owner', 'menu', id, 'categories'] as const,
  items: (id: string) => ['owner', 'menu', id, 'items'] as const,
  ordersPrefix: (id: string) => ['owner', 'orders', id] as const,
  orders: (id: string) => ['owner', 'orders', id, 'active'] as const,
  history: (id: string, filters: unknown, cursor?: string) => ['owner', 'orders', id, 'history', filters, cursor ?? null] as const,
  dashboard: (id: string) => ['owner', 'dashboard', id] as const,
  fin: (id: string, part: string, cursor?: string) => ['owner', 'finance', id, part, cursor ?? null] as const,
};

const base = (id: string) => `/owner/restaurants/${encodeURIComponent(id)}`;

export const restaurantApi = {
  list: () => api<{ items: OwnerRestaurant[] }>('/owner/restaurants').then((r) => r.items),
  get: (id: string) => api<OwnerRestaurant>(base(id)),
  create: (body: RestaurantPatch & { name: string }) =>
    api<{ restaurant: OwnerRestaurant; roleGranted: boolean }>('/owner/restaurants', { method: 'POST', body }),
  patch: (id: string, body: RestaurantPatch) => api<OwnerRestaurant>(base(id), { method: 'PATCH', body }),
  submit: (id: string) => api<OwnerRestaurant>(`${base(id)}/submit`, { method: 'POST' }),
  resendVerification: (id: string) =>
    api<{ sentAt: string; expiresAt: string }>(`${base(id)}/resend-verification`, { method: 'POST' }),
  setHours: (id: string, hours: HoursSlot[]) => api<OwnerRestaurant>(`${base(id)}/hours`, { method: 'PUT', body: { hours } }),
  setSettlement: (id: string, body: { accountHolder: string; accountNumber: string; ifsc: string }) =>
    api<{ accountHolder: string; ifsc: string; last4: string }>(`${base(id)}/settlement`, { method: 'PUT', body }),
  pause: (id: string, minutes: number) => api<OwnerRestaurant>(`${base(id)}/pause`, { method: 'POST', body: { minutes } }),
  resume: (id: string) => api<OwnerRestaurant>(`${base(id)}/resume`, { method: 'POST' }),
  attachDocument: (id: string, body: { type: string; key: string }) =>
    api<{ id: string; type: string; key: string; verified: boolean; uploadedAt: string | null }>(`${base(id)}/documents`, { method: 'POST', body }),
};

/** Push a fresh server copy of a restaurant into the caches the screens read from. */
export function cacheRestaurant(qc: QueryClient, r: OwnerRestaurant): void {
  qc.setQueryData(keys.restaurant(r.id), r);
  qc.setQueryData<OwnerRestaurant[]>(keys.restaurants, (list) => (list ? list.map((x) => (x.id === r.id ? r : x)) : list));
}

export function useRestaurants(enabled = true) {
  return useQuery({ queryKey: keys.restaurants, queryFn: restaurantApi.list, enabled });
}

export function useRestaurantById(id: string | undefined) {
  return useQuery({ queryKey: keys.restaurant(id ?? ''), queryFn: () => restaurantApi.get(id!), enabled: Boolean(id) });
}

/* ------------------------------------------------------------------ uploads */

export type UploadPurpose = 'IMAGE' | 'DOCUMENT';

export const UPLOAD_RULES: Record<UploadPurpose, { types: string[]; maxBytes: number; label: string }> = {
  IMAGE: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 2 * 1024 * 1024, label: 'JPG, PNG or WebP up to 2 MB' },
  DOCUMENT: { types: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 5 * 1024 * 1024, label: 'PDF, JPG or PNG up to 5 MB' },
};

/** Client-side pre-check mirroring the server rules (the server still verifies size and magic bytes). */
export function validateUpload(file: { type: string; size: number }, purpose: UploadPurpose): string | null {
  const rule = UPLOAD_RULES[purpose];
  if (!rule.types.includes(file.type.toLowerCase())) return `This file type isn't allowed. Use ${rule.label}.`;
  if (file.size <= 0) return 'This file is empty.';
  if (file.size > rule.maxBytes) return `This file is too large. Use ${rule.label}.`;
  return null;
}

interface Presign {
  key: string;
  bucket: 'public' | 'private';
  upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string; maxBytes: number };
}

export class UploadError extends Error {}

/**
 * Presign -> PUT to the signed URL with exactly the returned headers -> return the object key.
 * The caller attaches the key (PATCH images / POST documents / item imageKey), which re-verifies the object.
 */
export async function uploadFile(restaurantId: string, file: File, purpose: UploadPurpose): Promise<string> {
  const problem = validateUpload(file, purpose);
  if (problem) throw new UploadError(problem);
  const presign = await api<Presign>(`${base(restaurantId)}/uploads`, {
    method: 'POST',
    body: { purpose, contentType: file.type.toLowerCase(), sizeBytes: file.size },
  });
  let res: Response;
  try {
    res = await fetch(presign.upload.url, { method: 'PUT', body: file, headers: presign.upload.headers });
  } catch {
    throw new UploadError("Couldn't reach the upload server. Check your connection and try again.");
  }
  if (!res.ok) throw new UploadError(`The upload failed (${res.status}). Try again.`);
  return presign.key;
}

/* ------------------------------------------------------------------ menu */

export interface MenuCategory {
  id: string;
  restaurantId: string;
  name: string;
  sortOrder: number;
  active: boolean;
}
export interface MenuOption {
  id?: string;
  name: string;
  pricePaise: number;
  isVeg: boolean;
  available?: boolean;
}
export interface MenuGroup {
  id?: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: MenuOption[];
}
export interface OwnerItem {
  id: string;
  restaurantId: string;
  categoryId: string;
  name: string;
  description: string;
  pricePaise: number;
  isVeg: boolean;
  imageKey: string | null;
  imageUrl: string | null;
  available: boolean;
  trackStock: boolean;
  stockQty: number;
  reservedQty: number;
  availableQty: number | null;
  customizationGroups: MenuGroup[];
  tags: string[];
  updatedAt: string | null;
}
export type ItemBody = Partial<{
  categoryId: string;
  name: string;
  description: string;
  pricePaise: number;
  isVeg: boolean;
  imageKey: string | null;
  available: boolean;
  trackStock: boolean;
  stockQty: number;
  customizationGroups: MenuGroup[];
}>;

export const menuApi = {
  categories: (rid: string) => api<{ items: MenuCategory[] }>(`${base(rid)}/categories`).then((r) => r.items),
  createCategory: (rid: string, body: { name: string; sortOrder?: number; active?: boolean }) =>
    api<MenuCategory>(`${base(rid)}/categories`, { method: 'POST', body }),
  updateCategory: (rid: string, id: string, body: { name?: string; sortOrder?: number; active?: boolean }) =>
    api<MenuCategory>(`${base(rid)}/categories/${id}`, { method: 'PATCH', body }),
  deleteCategory: (rid: string, id: string) => api<void>(`${base(rid)}/categories/${id}`, { method: 'DELETE' }),
  items: (rid: string) => api<{ items: OwnerItem[] }>(`${base(rid)}/items`).then((r) => r.items),
  createItem: (rid: string, body: ItemBody & { categoryId: string; name: string; pricePaise: number; isVeg: boolean }) =>
    api<OwnerItem>(`${base(rid)}/items`, { method: 'POST', body }),
  updateItem: (rid: string, id: string, body: ItemBody) => api<OwnerItem>(`${base(rid)}/items/${id}`, { method: 'PATCH', body }),
  setAvailability: (rid: string, id: string, body: { available?: boolean; stockQty?: number; trackStock?: boolean }) =>
    api<OwnerItem>(`${base(rid)}/items/${id}/availability`, { method: 'PATCH', body }),
  deleteItem: (rid: string, id: string) => api<void>(`${base(rid)}/items/${id}`, { method: 'DELETE' }),
};

/* ------------------------------------------------------------------ orders (LLD 10; UNVERIFIED shapes) */

export interface OwnerOrderLine {
  itemId?: string;
  name: string;
  isVeg?: boolean;
  quantity: number;
  unitPricePaise?: number;
  lineTotalPaise?: number;
  addOns?: { id?: string; name: string; pricePaise?: number }[];
  /** Resolved names when the server provides them (selections only carry ids in the customer view). */
  selectionNames?: string[];
  note?: string | null;
}

export interface OwnerOrder {
  id: string;
  code: string;
  restaurantId?: string;
  status: ChildOrderStatus;
  lines: OwnerOrderLine[];
  breakdown?: { itemsSubtotalPaise?: number; totalPaise: number } & Record<string, number>;
  placedAt: string | null;
  /** Deadline for accepting (PLACED only). */
  acceptBy: string | null;
  acceptedAt?: string | null;
  prepMinutes?: number | null;
  readyEta?: string | null;
  readyAt?: string | null;
  /** 4 digits, shown to the restaurant; the partner enters it at pickup. */
  pickupCode?: string | null;
  customerContact?: { name?: string; phoneMasked?: string } | null;
  rejectionReason?: string | null;
  cancellationReason?: string | null;
  refundStatus?: string;
  refundedPaise?: number;
  deliveryStatus?: string | null;
  isDemo?: boolean;
}

export const ACTIVE_STATUSES: ChildOrderStatus[] = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'];
export const HISTORY_STATUS_OPTIONS: { value: ChildOrderStatus; label: string }[] = [
  { value: 'DELIVERED', label: 'Delivered' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'PICKED_UP', label: 'Picked up' },
  { value: 'OUT_FOR_DELIVERY', label: 'On the way' },
  { value: 'DELIVERY_FAILED', label: 'Delivery failed' },
];

export const ordersApi = {
  /** All recent orders of a restaurant, newest first (the board filters to active statuses). */
  recent: (restaurantId: string, limit = 100) =>
    api<Paginated<OwnerOrder>>('/owner/orders', { query: { restaurantId, limit } }),
  page: (q: { restaurantId: string; status?: string; from?: string; to?: string; cursor?: string; limit?: number }) =>
    api<Paginated<OwnerOrder>>('/owner/orders', { query: { limit: 20, ...q } }),
  get: (childId: string) => api<OwnerOrder>(`/owner/orders/${encodeURIComponent(childId)}`),
  accept: (childId: string, prepMinutes: number) =>
    api<OwnerOrder>(`/owner/orders/${encodeURIComponent(childId)}/accept`, { method: 'POST', body: { prepMinutes } }),
  reject: (childId: string, reason: string) =>
    api<OwnerOrder>(`/owner/orders/${encodeURIComponent(childId)}/reject`, { method: 'POST', body: { reason } }),
  preparing: (childId: string) => api<OwnerOrder>(`/owner/orders/${encodeURIComponent(childId)}/preparing`, { method: 'POST' }),
  ready: (childId: string) => api<OwnerOrder>(`/owner/orders/${encodeURIComponent(childId)}/ready`, { method: 'POST' }),
  setPrepTime: (childId: string, prepMinutes: number) =>
    api<OwnerOrder>(`/owner/orders/${encodeURIComponent(childId)}/prep-time`, { method: 'PATCH', body: { prepMinutes } }),
};

export const PREP_TIME_OPTIONS = [10, 15, 20, 25, 30, 40, 45, 60, 90];

/* ------------------------------------------------------------------ dashboard (UNVERIFIED) */

export interface DashboardMetrics {
  ordersToday: number | null;
  acceptedToday: number | null;
  rejectedToday: number | null;
  /** 0-100, null when there were no decided orders. */
  acceptanceRatePct: number | null;
  revenuePaise: number | null;
  avgPrepMinutes: number | null;
  /** Date label the server computed the numbers for, when present. */
  asOf: string | null;
  raw: unknown;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pick = (o: Record<string, unknown>, ...names: string[]): number | null => {
  for (const n of names) {
    const v = num(o[n]);
    if (v !== null) return v;
  }
  return null;
};

/** Tolerant reader: the dashboard payload is not specified beyond LLD 10, so accept the plausible spellings. */
export function normalizeDashboard(raw: unknown): DashboardMetrics {
  const root = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const o = (root.today && typeof root.today === 'object' ? { ...root, ...(root.today as object) } : root) as Record<string, unknown>;
  const ordersToday = pick(o, 'ordersToday', 'todayOrders', 'orders', 'ordersCount', 'orderCount', 'placed');
  const accepted = pick(o, 'acceptedToday', 'accepted', 'acceptedCount');
  const rejected = pick(o, 'rejectedToday', 'rejected', 'rejectedCount');
  let rate = pick(o, 'acceptanceRatePct', 'acceptanceRatePercent');
  if (rate === null) {
    const bps = pick(o, 'acceptanceRateBps');
    if (bps !== null) rate = bps / 100;
  }
  if (rate === null) {
    const r = pick(o, 'acceptanceRate');
    if (r !== null) rate = r <= 1 ? r * 100 : r;
  }
  if (rate === null && accepted !== null && rejected !== null && accepted + rejected > 0) {
    rate = (accepted / (accepted + rejected)) * 100;
  }
  return {
    ordersToday,
    acceptedToday: accepted,
    rejectedToday: rejected,
    acceptanceRatePct: rate === null ? null : Math.round(rate * 10) / 10,
    revenuePaise: pick(o, 'revenuePaise', 'todayRevenuePaise', 'grossPaise', 'earningsPaise'),
    avgPrepMinutes: pick(o, 'avgPrepMinutes', 'averagePrepMinutes'),
    asOf: typeof o.asOf === 'string' ? o.asOf : typeof o.date === 'string' ? o.date : null,
    raw,
  };
}

export const dashboardApi = {
  get: (restaurantId: string) => api<unknown>(`${base(restaurantId)}/dashboard`).then(normalizeDashboard),
};

/* ------------------------------------------------------------------ finance (payments service, verified) */

export interface FinanceSummary {
  accountType: string;
  accountId: string;
  balancePaise: number;
  availablePaise: number;
  pendingPayoutPaise: number;
  paidOutPaise: number;
  holdDays: number;
  totalsByType: Partial<Record<LedgerEntryType, number>>;
  asOf: string;
}
export interface LedgerRow {
  id: string;
  entryType: LedgerEntryType;
  amountPaise: number;
  childOrderId: string | null;
  payoutId: string | null;
  refundId: string | null;
  memo: string;
  createdAt: string;
}
export interface PayoutRow {
  id: string;
  amountPaise: number;
  status: PayoutStatus;
  method: string;
  utr: string | null;
  confirmedAt: string | null;
  failureReason: string | null;
  notes: string | null;
  createdAt: string;
}

const fin = (rid: string) => `/finance/restaurants/${encodeURIComponent(rid)}`;
export const financeApi = {
  summary: (rid: string) => api<FinanceSummary>(`${fin(rid)}/summary`),
  ledger: (rid: string, cursor?: string) => api<Paginated<LedgerRow>>(`${fin(rid)}/ledger`, { query: { limit: 20, cursor } }),
  payouts: (rid: string, cursor?: string) => api<Paginated<PayoutRow>>(`${fin(rid)}/payouts`, { query: { limit: 20, cursor } }),
};

export const LEDGER_LABELS: Record<string, string> = {
  ORDER_EARNING: 'Order earning',
  COMMISSION: 'Commission',
  REFUND_ADJUSTMENT: 'Refund adjustment',
  MANUAL_ADJUSTMENT: 'Manual adjustment',
  PAYOUT: 'Payout',
  DELIVERY_EARNING: 'Delivery earning',
};

/**
 * A payout is only ever shown as "Paid" when the server marks it PAID AND a UTR is recorded. A PAID payout
 * without a UTR is shown as awaiting confirmation, never as money received.
 */
export function payoutDisplay(p: Pick<PayoutRow, 'status' | 'utr'>): { label: string; tone: 'success' | 'warn' | 'info' | 'danger' | 'neutral' } {
  const utr = p.utr?.trim();
  switch (p.status) {
    case 'PAID':
      return utr ? { label: 'Paid', tone: 'success' } : { label: 'Awaiting UTR confirmation', tone: 'warn' };
    case 'PROCESSING':
      return { label: 'Processing', tone: 'info' };
    case 'REQUESTED':
      return { label: 'Requested', tone: 'warn' };
    case 'FAILED':
      return { label: 'Failed', tone: 'danger' };
    case 'CANCELLED':
      return { label: 'Cancelled', tone: 'neutral' };
    default:
      return { label: 'Unknown', tone: 'neutral' };
  }
}

/* ------------------------------------------------------------------ helpers */

/** Rupee text -> integer paise (rounded at the input boundary). null when invalid or negative. */
export function rupeesToPaise(text: string): number | null {
  const t = text.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const paise = Math.round(Number(t) * 100);
  return Number.isSafeInteger(paise) ? paise : null;
}

export function paiseToRupees(paise: number): string {
  const whole = Math.floor(paise / 100);
  const frac = paise % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`;
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Monday-first display order of the API's day numbers (0 = Sunday). */
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export const DOCUMENT_TYPES: { type: string; label: string; required: boolean }[] = [
  { type: 'FSSAI', label: 'FSSAI licence', required: true },
  { type: 'GST', label: 'GST certificate', required: true },
  { type: 'PAN', label: 'PAN card', required: true },
  { type: 'TRADE_LICENSE', label: 'Trade licence', required: false },
  { type: 'OTHER', label: 'Other document', required: false },
];

/**
 * Fields still missing before submit, in the same terms as the server's `missingFields` (PRD R-1). Required
 * document types are configurable on the server (default FSSAI, GST, PAN); the server's 422 `details.missing`
 * remains the final word.
 */
export function missingForSubmit(r: OwnerRestaurant): { key: string; label: string; step: string }[] {
  const out: { key: string; label: string; step: string }[] = [];
  const blank = (v: string | null | undefined) => !v || v.trim() === '';
  if (blank(r.businessName)) out.push({ key: 'businessName', label: 'Business name', step: 'business' });
  if (blank(r.name)) out.push({ key: 'name', label: 'Restaurant name', step: 'business' });
  if (blank(r.description)) out.push({ key: 'description', label: 'Description', step: 'business' });
  if (!r.cuisines.length) out.push({ key: 'cuisines', label: 'At least one cuisine', step: 'business' });
  if (blank(r.phone)) out.push({ key: 'phone', label: 'Phone number', step: 'business' });
  if (blank(r.businessEmail)) out.push({ key: 'businessEmail', label: 'Business email', step: 'business' });
  if (!r.address?.line1 || !r.address?.city || !r.address?.pincode) out.push({ key: 'address', label: 'Address', step: 'location' });
  if (!r.location) out.push({ key: 'location', label: 'Map pin', step: 'location' });
  if (!r.hours.length) out.push({ key: 'hours', label: 'Opening hours', step: 'hours' });
  const have = new Set(r.documents.map((d) => d.type));
  for (const d of DOCUMENT_TYPES) {
    if (d.required && !have.has(d.type)) out.push({ key: `documents.${d.type}`, label: d.label, step: 'documents' });
  }
  if (!r.settlement) out.push({ key: 'settlement', label: 'Settlement bank details', step: 'settlement' });
  return out;
}
