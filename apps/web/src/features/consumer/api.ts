/**
 * Consumer API layer: response types (sourced from the implemented services' zod schemas; see notes per type),
 * fetchers, query keys and small React hooks shared by the consumer pages.
 *
 * Verified against service code (2026-10-10):
 *   marketplace  GET /discovery/restaurants|search|serviceability, GET /restaurants/:idOrSlug, /cuisines, /banners
 *   orders       /cart/*, POST /cart/preview, POST /checkouts, GET /checkouts/:id
 *   payments     POST /payments/:intentId/verify, GET|POST /demo-pay/:intentId[/complete]
 *   identity     /me, /me/addresses, /me/notification-prefs
 *   delivery     GET /deliveries/tracking/:childOrderId
 *   notifications GET /notifications, POST /notifications/:id/read
 * Lifecycle / commerce (orders order-schemas.ts, marketplace memberships.ts, coupons.ts):
 *   orders       GET /orders, GET /orders/:checkoutId, POST /orders/child/:id/cancel, POST /orders/:id/reorder, /support/tickets*
 *   marketplace  GET /coupons/available, GET /memberships/plans|me, POST /memberships/purchase
 * (all of the above re-verified against the implemented services in review round 1)
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Breakdown, GeoPoint, Selection } from '@thali/contracts';
import { api, getAccessToken } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ApiError, isApiError } from '../../lib/errors';
import { clearGuestCartToken, hasGuestCart } from '../../lib/guest';

export type { Breakdown, GeoPoint, Selection };

/* ------------------------------------------------------------------ discovery (marketplace) */

export type EtaSource = 'GOOGLE' | 'DEMO_HAVERSINE' | 'HAVERSINE_FALLBACK' | (string & {});
export interface Rating {
  average: number;
  count: number;
}
export interface MatchedItem {
  id: string;
  name: string;
  pricePaise: number;
  isVeg: boolean;
  imageUrl: string | null;
}
export interface DiscoveryRestaurant {
  id: string;
  slug: string;
  name: string;
  cuisines: string[];
  imageUrl: string | null;
  isVeg?: 'PURE_VEG' | 'MIXED';
  open: boolean;
  nextOpenAt?: string;
  distanceKm: number;
  deliveryFeePaise: number;
  etaMinutes: number;
  etaSource: EtaSource;
  rating: Rating | null;
  priceBand: number | null;
  isDemo: boolean;
  matchedItems?: MatchedItem[];
}
export interface ServiceArea {
  id: string;
  name: string;
  minOrderPaise: number;
}
export interface DiscoveryPage {
  items: DiscoveryRestaurant[];
  nextCursor: string | null;
  serviceable: boolean;
  serviceArea: ServiceArea | null;
}
export interface SearchResult {
  serviceable: boolean;
  restaurants: DiscoveryRestaurant[];
  items: (MatchedItem & { restaurantId: string; restaurantName: string })[];
}
export type DiscoverySort = 'distance' | 'deliveryFee' | 'eta' | 'rating';
export interface DiscoveryFilterState {
  q?: string;
  veg?: boolean;
  cuisine?: string[];
  priceBand?: number[];
  openNow?: boolean;
  sort: DiscoverySort;
}

export interface CustomizationOption {
  id: string;
  name: string;
  pricePaise: number;
  isVeg: boolean;
  available: boolean;
}
export interface CustomizationGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: CustomizationOption[];
}
export interface MenuItem {
  id: string;
  restaurantId: string;
  categoryId: string;
  name: string;
  description: string;
  pricePaise: number;
  isVeg: boolean;
  imageUrl: string | null;
  available: boolean;
  customizationGroups: CustomizationGroup[];
  tags: string[];
}
export interface RestaurantPageData {
  restaurant: {
    id: string;
    slug: string;
    name: string;
    description: string;
    cuisines: string[];
    imageUrl: string | null;
    logoUrl: string | null;
    address: { line1: string; line2?: string; city: string; pincode: string } | null;
    location: GeoPoint | null;
    hours: { day: number; open: string; close: string }[];
    timezone: string;
    open: boolean;
    closedReason?: 'PAUSED' | 'OUTSIDE_HOURS' | 'NOT_APPROVED';
    nextOpenAt?: string;
    isVeg?: 'PURE_VEG' | 'MIXED';
    priceBand: number | null;
    rating: Rating | null;
    packagingFeePaise: number;
    avgPrepMinutes: number;
    isDemo: boolean;
  };
  delivery: {
    deliverable: boolean;
    reason?: string;
    distanceKm: number | null;
    deliveryFeePaise?: number;
    etaMinutes?: number;
    etaSource?: string;
    minOrderPaise?: number;
  } | null;
  menu: { id: string; name: string; sortOrder: number; items: MenuItem[] }[];
}
export interface Cuisine {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  sortOrder: number;
}
export interface Banner {
  id: string;
  title: string;
  imageUrl: string;
  linkType: 'RESTAURANT' | 'CUISINE' | 'COUPON';
  linkValue: string;
  isDemo: boolean;
}

export function discoveryQuery(point: GeoPoint, f: DiscoveryFilterState, cursor?: string | null) {
  return api<DiscoveryPage>('/discovery/restaurants', {
    auth: false,
    query: {
      lat: point.lat,
      lng: point.lng,
      q: f.q?.trim() || undefined,
      veg: f.veg ? 'true' : undefined,
      cuisine: f.cuisine?.length ? f.cuisine.join(',') : undefined,
      priceBand: f.priceBand?.length ? f.priceBand.join(',') : undefined,
      openNow: f.openNow ? 'true' : undefined,
      sort: f.sort,
      cursor: cursor ?? undefined,
    },
  });
}

/* ------------------------------------------------------------------ cart (orders) */

export interface AddOn {
  id: string;
  name: string;
  pricePaise: number;
}
export interface AddressSnapshot {
  addressId: string | null;
  label: string | null;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  pincode: string;
  location: GeoPoint;
}
export interface DeliveryMode {
  mode: 'SEPARATE';
  note: string;
}
export interface CartLine {
  lineId: string;
  restaurantId: string;
  itemId: string;
  name: string;
  isVeg: boolean;
  unitPricePaise: number;
  addOns: AddOn[];
  selections: Selection[];
  quantity: number;
  note: string | null;
  lineTotalPaise: number;
}
export interface CartGroup {
  restaurantId: string;
  restaurantName: string;
  lines: CartLine[];
  subtotalPaise: number;
  itemCount: number;
  delivery: DeliveryMode;
}
export interface Cart {
  id: string | null;
  ownerType: 'USER' | 'GUEST';
  cartVersion: number;
  groups: CartGroup[];
  restaurantCount: number;
  itemCount: number;
  subtotalPaise: number;
  deliveryAddress: AddressSnapshot | null;
  couponCode: string | null;
  expiresAt: string | null;
  deliveryExplanation: string | null;
}

export const EMPTY_CART: Cart = {
  id: null,
  ownerType: 'GUEST',
  cartVersion: 0,
  groups: [],
  restaurantCount: 0,
  itemCount: 0,
  subtotalPaise: 0,
  deliveryAddress: null,
  couponCode: null,
  expiresAt: null,
  deliveryExplanation: null,
};

export const CART_KEY = ['cart'] as const;

const isGuestCartGone = (e: unknown) => isApiError(e) && e.status === 404 && !getAccessToken();

/**
 * GET /cart. Signed out with no guest token -> empty cart without a request. Signed out 401 (no token) or a
 * stale guest token (404) -> empty cart (the stale token is dropped so the next add creates a new one).
 */
export async function fetchCart(): Promise<Cart> {
  if (!getAccessToken() && !hasGuestCart()) return EMPTY_CART;
  try {
    return await api<Cart>('/cart', { guest: true });
  } catch (e) {
    if (isApiError(e) && e.status === 401 && !getAccessToken()) return EMPTY_CART;
    if (isGuestCartGone(e)) {
      clearGuestCartToken();
      return EMPTY_CART;
    }
    throw e;
  }
}

/** Cart mutation with one retry when a signed-out guest token has expired (server 404 for the cart itself). */
async function cartMutation<T>(path: string, method: 'POST' | 'PATCH' | 'DELETE' | 'PUT', body?: unknown): Promise<T> {
  try {
    return await api<T>(path, { method, body, guest: true });
  } catch (e) {
    if (isGuestCartGone(e) && /guest cart/i.test((e as ApiError).message)) {
      clearGuestCartToken();
      return api<T>(path, { method, body, guest: true });
    }
    throw e;
  }
}

export interface AddItemInput {
  restaurantId: string;
  itemId: string;
  quantity: number;
  selections: Selection[];
  note?: string;
}
export const cartApi = {
  add: (input: AddItemInput) => cartMutation<{ lineId: string; cart: Cart }>('/cart/items', 'POST', input),
  update: (lineId: string, patch: { quantity?: number; selections?: Selection[]; note?: string }) =>
    cartMutation<Cart>(`/cart/items/${lineId}`, 'PATCH', patch),
  remove: (lineId: string) => cartMutation<Cart>(`/cart/items/${lineId}`, 'DELETE'),
  clear: () => cartMutation<Cart>('/cart', 'DELETE'),
  setCoupon: (couponCode: string | null) => cartMutation<Cart>('/cart/coupon', 'PUT', { couponCode }),
};

/** The cart query (shared by header badge, drawer, cart page, checkout). */
export function useCart() {
  const { status, user } = useAuth();
  return useQuery({
    queryKey: [...CART_KEY, user?.id ?? 'guest'],
    queryFn: fetchCart,
    enabled: status !== 'loading',
    staleTime: 10_000,
  });
}

/** Write a fresh cart (returned by a mutation) into every cart query and refresh previews. */
export function useCartWriter() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return (cart: Cart) => {
    qc.setQueryData([...CART_KEY, user?.id ?? 'guest'], cart);
    void qc.invalidateQueries({ queryKey: ['checkout-preview'] });
  };
}

/* ------------------------------------------------------------------ preview / checkout (orders) */

export interface DeliveryAddressInput {
  label?: string;
  line1: string;
  line2?: string;
  landmark?: string;
  city: string;
  pincode: string;
  location: GeoPoint;
}
export type QuoteProblemCode = 'RESTAURANT_CLOSED' | 'NOT_SERVICEABLE' | 'ITEM_UNAVAILABLE' | 'INVALID_SELECTION' | 'OUT_OF_STOCK' | (string & {});
export interface QuoteProblem {
  code: QuoteProblemCode;
  restaurantId?: string;
  itemId?: string;
  message: string;
}
export interface PricedChild {
  restaurantId: string;
  restaurantName: string;
  lines: { lineId: string; itemId: string; name: string; unitPricePaise: number; addOns: AddOn[]; quantity: number; lineTotalPaise: number }[];
  breakdown: Breakdown;
  distanceKm: number;
  etaMinutes: number;
  etaSource: EtaSource;
  delivery: DeliveryMode;
}
export interface CartPreview {
  cartVersion: number;
  deliveryAddress: AddressSnapshot | null;
  pricing: Breakdown;
  children: PricedChild[];
  problems: QuoteProblem[];
  canCheckout: boolean;
  coupon: { code: string; valid: boolean; discountPaise: number; message?: string } | null;
  membership: { applied: boolean; membershipId: string | null } | null;
  deliveryExplanation: string | null;
}
export interface PreviewBody {
  address?: DeliveryAddressInput;
  couponCode?: string | null;
  useMembership?: boolean;
}
export const previewCart = (body: PreviewBody) => api<CartPreview>('/cart/preview', { method: 'POST', body });

export type ChildOrderStatus =
  | 'AWAITING_PAYMENT' | 'PLACED' | 'ACCEPTED' | 'PREPARING' | 'READY_FOR_PICKUP' | 'PICKED_UP' | 'OUT_FOR_DELIVERY'
  | 'DELIVERED' | 'DELIVERY_FAILED' | 'PAYMENT_FAILED' | 'EXPIRED' | 'REJECTED' | 'CANCELLED';
export type CheckoutStatus =
  | 'AWAITING_PAYMENT' | 'PAID_PLACED' | 'IN_PROGRESS' | 'COMPLETED' | 'PARTIALLY_COMPLETED' | 'CANCELLED' | 'PAYMENT_FAILED' | 'EXPIRED';
export type ChildRefundStatus = 'NONE' | 'REQUESTED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | (string & {});

export interface StatusHistoryEntry {
  from: string | null;
  to: string;
  actor: string;
  reason: string | null;
  at: string | null;
}
export interface ChildOrder {
  id: string;
  code: string;
  restaurantId: string;
  restaurantName: string;
  status: ChildOrderStatus;
  lines: (Omit<CartLine, 'lineId' | 'restaurantId'> & { itemId: string })[];
  breakdown: Breakdown;
  acceptBy: string | null;
  placedAt: string | null;
  deliveryCode: string;
  refundStatus: ChildRefundStatus;
  refundedPaise: number;
  deliveryStatus: string | null;
  eta: { distanceKm: number | null; etaMinutes: number | null; etaSource: string | null };
  delivery: DeliveryMode;
  /** Customer lifecycle fields (`CustomerChildOrder`, GET /orders/:checkoutId); absent on GET /checkouts/:id. */
  prepMinutes?: number | null;
  readyEta?: string | null;
  rejectionReason?: string | null;
  cancellationReason?: string | null;
  refundRequestedPaise?: number;
  partner?: { name: string; vehicleType: string | null } | null;
  canCancel?: boolean;
  statusHistory?: StatusHistoryEntry[];
}
export interface CheckoutView {
  id: string;
  code: string;
  status: CheckoutStatus;
  cartVersion: number;
  createdAt: string | null;
  expiresAt: string | null;
  placedAt: string | null;
  deliveryAddress: AddressSnapshot | null;
  pricing: Breakdown;
  couponCode: string | null;
  membershipId: string | null;
  paymentIntentId: string | null;
  paymentStatus: string;
  isDemo: boolean;
  deliveryExplanation: string | null;
  children: ChildOrder[];
}
export interface PaymentView {
  intentId: string;
  provider: 'razorpay' | 'mock';
  providerOrderId: string;
  keyId: string | null;
  amountPaise: number;
  currency: 'INR';
  demoPayUrl: string | null;
}
export interface CheckoutResponse {
  checkout: CheckoutView;
  payment: PaymentView | null;
}
export interface CreateCheckoutBody {
  address: DeliveryAddressInput;
  couponCode?: string;
  useMembership: boolean;
  expectedTotalPaise?: number;
}
export const createCheckout = (body: CreateCheckoutBody, idempotencyKey: string) =>
  api<CheckoutResponse>('/checkouts', { method: 'POST', body, idempotencyKey });
export const fetchCheckout = (id: string) => api<CheckoutResponse>(`/checkouts/${id}`);

/** PRICE_CHANGED details (orders checkout.ts). */
export interface PriceChangedDetails {
  expectedTotalPaise: number;
  pricing: Breakdown;
  children: PricedChild[];
}
export function priceChangedDetails(e: unknown): PriceChangedDetails | null {
  if (!isApiError(e) || e.code !== 'PRICE_CHANGED') return null;
  const d = e.details as Partial<PriceChangedDetails> | undefined;
  if (!d || typeof d.expectedTotalPaise !== 'number' || !d.pricing) return null;
  return { expectedTotalPaise: d.expectedTotalPaise, pricing: d.pricing, children: Array.isArray(d.children) ? d.children : [] };
}
export function problemsFromError(e: unknown): QuoteProblem[] {
  if (!isApiError(e)) return [];
  const d = e.details as { problems?: QuoteProblem[] } | undefined;
  return Array.isArray(d?.problems) ? d!.problems! : [];
}

/* ------------------------------------------------------------------ payments */

export interface RazorpayHandlerResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}
export interface PaymentStatusView {
  paymentIntentId: string;
  status: string;
  purpose: 'CHECKOUT' | 'MEMBERSHIP';
  referenceId: string;
  isDemo: boolean;
  reconciled?: boolean;
}
export const verifyPayment = (intentId: string, body: RazorpayHandlerResponse) =>
  api<PaymentStatusView>(`/payments/${intentId}/verify`, { method: 'POST', body });

export interface DemoPayView {
  paymentIntentId: string;
  purpose: 'CHECKOUT' | 'MEMBERSHIP';
  referenceId: string;
  amountPaise: number;
  currency: 'INR';
  status: string;
  providerOrderId: string;
  isDemo: true;
}
export const fetchDemoPay = (intentId: string) => api<DemoPayView>(`/demo-pay/${intentId}`, { auth: false });
export const completeDemoPay = (intentId: string, outcome: 'success' | 'failure') =>
  api<{ paymentIntentId: string; status: string; simulated: true }>(`/demo-pay/${intentId}/complete`, {
    method: 'POST',
    body: { outcome },
    auth: false,
  });

/** Accepts the orders `PaymentView` and LLD-shaped membership payment objects (`paymentIntentId`). */
export function normalizePayment(raw: unknown): PaymentView | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const intentId = (p.intentId ?? p.paymentIntentId) as string | undefined;
  if (typeof intentId !== 'string') return null;
  return {
    intentId,
    provider: p.provider === 'razorpay' ? 'razorpay' : 'mock',
    providerOrderId: String(p.providerOrderId ?? ''),
    keyId: typeof p.keyId === 'string' ? p.keyId : null,
    amountPaise: Number(p.amountPaise ?? 0),
    currency: 'INR',
    demoPayUrl: typeof p.demoPayUrl === 'string' ? p.demoPayUrl : null,
  };
}

/* ------------------------------------------------------------------ orders lifecycle (orders order-schemas.ts) */

export interface OrderExplanation {
  childOrderId: string;
  restaurantName: string;
  kind: 'REJECTED' | 'CANCELLED' | 'DELIVERY_FAILED';
  reason: string | null;
  refundPaise: number;
  refundStatus: ChildRefundStatus;
  message: string;
}
/** Server rule (orders derive.ts): netPaise = paidPaise − refundedPaise (pending refunds NOT subtracted). */
export interface AdjustedTotals {
  paidPaise: number;
  refundedPaise: number;
  refundPendingPaise: number;
  netPaise: number;
}
/** `GET /orders/:checkoutId` → `OrderDetail`. */
export interface OrderDetail {
  checkout: CheckoutView;
  explanations: OrderExplanation[];
  adjustedTotals: AdjustedTotals;
}
export const fetchOrder = (checkoutId: string) => api<OrderDetail>(`/orders/${checkoutId}`);

/** `GET /orders` items (`orderSummary()`). */
export interface OrderSummary {
  id: string;
  code: string;
  status: CheckoutStatus;
  createdAt: string | null;
  placedAt: string | null;
  totalPaise: number;
  adjustedTotals: AdjustedTotals;
  children: {
    id: string;
    code: string;
    restaurantId: string;
    restaurantName: string;
    status: ChildOrderStatus;
    itemCount: number;
    totalPaise: number;
    refundStatus: ChildRefundStatus;
  }[];
}
export const fetchOrders = (cursor?: string | null) =>
  api<{ items: OrderSummary[]; nextCursor: string | null }>('/orders', { query: { limit: 10, cursor: cursor ?? undefined } });
/** `CustomerCancelBody { reason? }`. */
export const cancelChild = (childId: string, reason?: string) =>
  api<unknown>(`/orders/child/${childId}/cancel`, { method: 'POST', body: reason ? { reason } : {} });
export interface ReorderChange {
  kind: 'PRICE_CHANGED' | 'ITEM_UNAVAILABLE' | 'OUT_OF_STOCK' | 'INVALID_SELECTION' | 'RESTAURANT_CLOSED' | 'QUANTITY_LIMIT' | (string & {});
  restaurantId: string;
  restaurantName: string;
  itemId: string;
  name: string;
  quantity: number;
  added: boolean;
  oldUnitPricePaise?: number;
  newUnitPricePaise?: number;
  message: string;
}
export interface ReorderResult {
  cart: Cart;
  addedCount: number;
  changes: ReorderChange[];
}
export const reorder = (checkoutId: string) => api<ReorderResult>(`/orders/${checkoutId}/reorder`, { method: 'POST' });

export interface TrackingView {
  childOrderId: string;
  status: string;
  partner: { firstName: string; vehicleType: string } | null;
  location: GeoPoint | null;
  lastLocationAt: string | null;
  stale: boolean;
  simulated: boolean;
  estimatedMinutes: number;
  estimateSource: string;
}
export const fetchTracking = (childId: string) => api<TrackingView>(`/deliveries/tracking/${childId}`);

/* ------------------------------------------------------------------ identity */

export interface SavedAddress {
  id: string;
  label: string | null;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  pincode: string;
  location: GeoPoint;
  isDefault: boolean;
}
export interface NotificationPrefs {
  orderSms: boolean;
  orderEmail: boolean;
  marketingSms: boolean;
  marketingEmail: boolean;
}
export interface Me {
  id: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  roles: string[];
  notificationPrefs: NotificationPrefs;
  addresses: SavedAddress[];
  createdAt: string;
}
export const ADDRESSES_KEY = ['me', 'addresses'] as const;
export const fetchAddresses = () => api<{ items: SavedAddress[] }>('/me/addresses').then((r) => r.items);
export function useAddresses(enabled = true) {
  return useQuery({ queryKey: ADDRESSES_KEY, queryFn: fetchAddresses, enabled });
}
export const addressToInput = (a: SavedAddress | AddressSnapshot): DeliveryAddressInput => ({
  ...(a.label ? { label: a.label } : {}),
  line1: a.line1,
  ...(a.line2 ? { line2: a.line2 } : {}),
  ...(a.landmark ? { landmark: a.landmark } : {}),
  city: a.city,
  pincode: a.pincode,
  location: a.location,
});
export const formatAddress = (a: Pick<SavedAddress, 'line1' | 'line2' | 'city' | 'pincode'>) =>
  [a.line1, a.line2, a.city, a.pincode].filter(Boolean).join(', ');

/* ------------------------------------------------------------------ memberships (marketplace routes/memberships.ts) */

export interface PlanBenefits {
  freeDeliveryMinOrderPaise: number;
  freeDeliveriesPerPeriod: number;
  extraDiscountBps: number;
  extraDiscountCapPaise: number;
}
export interface MembershipPlan {
  id: string;
  name: string;
  pricePaise: number;
  durationDays: number;
  benefits: PlanBenefits;
  terms: string;
  active: boolean;
}
export interface Membership {
  id: string;
  planId: string;
  plan: { name: string; pricePaise: number; durationDays: number; benefits: PlanBenefits; terms: string };
  status: 'PENDING_PAYMENT' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
  startsAt: string | null;
  endsAt: string | null;
  paymentIntentId: string | null;
  freeDeliveriesUsed: number;
  freeDeliveriesRemaining: number;
  createdAt: string | null;
}
export interface MyMemberships {
  current: Membership | null;
  history: Membership[];
}
export const fetchPlans = () => api<{ items: MembershipPlan[] }>('/memberships/plans', { auth: false }).then((r) => r.items);
export const fetchMyMemberships = () => api<MyMemberships>('/memberships/me');
export const MEMBERSHIP_KEY = ['memberships', 'me'] as const;
export interface MembershipPaymentIntent {
  paymentIntentId: string;
  provider: 'razorpay' | 'mock';
  providerOrderId: string;
  keyId: string | null;
  amountPaise: number;
  currency: 'INR';
  status: string;
  demoPayUrl: string | null;
}
export const purchaseMembership = (planId: string, idempotencyKey: string) =>
  api<{ membership: Membership; payment: MembershipPaymentIntent }>('/memberships/purchase', { method: 'POST', body: { planId }, idempotencyKey });

export interface AvailableCoupon {
  code: string;
  description: string;
  minOrderPaise?: number;
}
export const fetchCoupons = () => api<{ items: AvailableCoupon[] }>('/coupons/available').then((r) => r.items);

/* ------------------------------------------------------------------ support (orders TicketView) */

export type TicketCategory = 'ORDER_ISSUE' | 'PAYMENT' | 'DELIVERY' | 'ACCOUNT' | 'OTHER';
export interface TicketMessage {
  authorId: string;
  authorRole: 'CUSTOMER' | 'ADMIN';
  body: string;
  at: string | null;
}
export interface SupportTicket {
  id: string;
  code: string;
  userId: string;
  childOrderId: string | null;
  checkoutGroupId: string | null;
  subject: string;
  category: TicketCategory;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
  priority: string;
  assigneeId: string | null;
  messages: TicketMessage[];
  createdAt: string | null;
  updatedAt: string | null;
}
export interface CreateTicketInput {
  subject: string;
  category: TicketCategory;
  body: string;
  childOrderId?: string;
  checkoutGroupId?: string;
}
export const fetchTickets = () => api<{ items: SupportTicket[]; nextCursor: string | null }>('/support/tickets').then((r) => r.items);
export const fetchTicket = (id: string) => api<SupportTicket>(`/support/tickets/${id}`);
export const createTicket = (input: CreateTicketInput) => api<SupportTicket>('/support/tickets', { method: 'POST', body: input });
export const replyTicket = (id: string, body: string) => api<SupportTicket>(`/support/tickets/${id}/messages`, { method: 'POST', body: { body } });

/* ------------------------------------------------------------------ notifications */

export interface InAppNotification {
  id: string;
  template: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}
export const fetchNotifications = (cursor?: string | null) =>
  api<{ items: InAppNotification[]; nextCursor: string | null; unreadCount: number }>('/notifications', {
    query: { limit: 20, cursor: cursor ?? undefined },
  });

/* ------------------------------------------------------------------ helpers */

export const isDemoEstimate = (s: string | null | undefined) => s === 'DEMO_HAVERSINE';
export const etaLabel = (s: string | null | undefined) => (isDemoEstimate(s) ? 'demo estimate' : 'estimate');

/** "Refund initiated" (REQUESTED/PROCESSING) vs "Refunded" (SUCCEEDED) vs "Refund failed — we're retrying". */
export function refundLabel(status: ChildRefundStatus): string | null {
  switch (status) {
    case 'REQUESTED':
    case 'PROCESSING':
      return 'Refund initiated';
    case 'SUCCEEDED':
      return 'Refunded';
    case 'FAILED':
      return 'Refund delayed';
    default:
      return null;
  }
}
