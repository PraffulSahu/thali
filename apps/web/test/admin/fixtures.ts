/** Shared admin test fixtures (shapes from the implemented services: ORD-1/2, DLV-4/5/7, NTF-1, GW-1). */
import { vi } from 'vitest';
import type { AdminRole } from '@thali/contracts';
import { makeAuth } from '../utils';

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const adminAuth = (adminRoles: AdminRole[] = ['OPS']) =>
  makeAuth({ roles: ['ADMIN'], adminRoles, hasMfa: true, amr: ['pwd', 'mfa'], user: { id: 'adm1', name: 'Nisha K.', phone: null, roles: ['ADMIN'], adminRoles } as never });

export interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** Route fetch by URL substring; first match wins. Records every call. */
export function routeFetch(routes: [match: string | RegExp, respond: (url: string, init?: RequestInit) => Response][]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const hit = routes.find(([m]) => (typeof m === 'string' ? url.includes(m) : m.test(url)));
      return Promise.resolve(hit ? hit[1](url, init) : json({ items: [], nextCursor: null }));
    }),
  );
  return calls;
}

export const ordersOverview = {
  generatedAt: '2026-10-11T08:00:00.000Z',
  today: {
    since: '2026-10-10T18:30:00.000Z',
    checkouts: 42,
    placed: 51,
    delivered: 38,
    rejected: 3,
    cancelled: 1,
    gmvPaise: 2841600,
    byStatus: {
      AWAITING_PAYMENT: 0, PLACED: 2, ACCEPTED: 2, PREPARING: 3, READY_FOR_PICKUP: 1, PICKED_UP: 0, OUT_FOR_DELIVERY: 1, DELIVERED: 38,
      DELIVERY_FAILED: 0, PAYMENT_FAILED: 0, EXPIRED: 0, REJECTED: 3, CANCELLED: 1,
    },
    refundedPaise: 120420,
  },
  activeByStatus: {},
  awaitingAcceptance: 2,
  overdueAcceptance: 0,
  deliveryFailed: 0,
  refundsPending: 1,
  refundsPendingPaise: 21810,
  refundsFailed: 0,
  support: { open: 4, inProgress: 1 },
};

export const tmsOverview = {
  jobsByStatus: { PENDING_ASSIGNMENT: 1, OFFERED: 0, ASSIGNED: 1, OUT_FOR_DELIVERY: 1 },
  unassigned: 1,
  exceptions: 1,
  liveOffers: 0,
  partners: { byStatus: { APPROVED: 2, APPROVAL_PENDING: 1 }, approved: 2, online: 2, onDelivery: 1 },
  generatedAt: '2026-10-11T08:00:00.000Z',
};

export const marketOverview = {
  generatedAt: '2026-10-11T08:00:00.000Z',
  restaurants: { total: 20, byStatus: { APPROVAL_PENDING: 2, APPROVED: 17, SUSPENDED: 1 }, pendingApproval: 2, pendingVerification: 0 },
  coupons: { total: 0, active: 0, redeemed: 0, redeemedDiscountPaise: 0, held: 0 },
  memberships: { active: 0, pendingPayment: 0, byStatus: {} },
  reservations: { held: 0 },
  ratings: { total: 0 },
  menu: { items: 0 },
};

const upDetails = { service: 'x', mode: 'demo', mongo: 'up', redis: 'up', outboxPending: 0, outboxOldestAgeSec: null, consumerLag: {}, deadLetters: 0, providerErrorsLastHour: 0, providerErrorsByProvider: {} };
export const healthReport = {
  checkedAt: new Date(Date.now() - 14_000).toISOString(),
  overall: 'degraded',
  gateway: { status: 'up', mode: 'demo', redis: 'up' },
  services: {
    identity: { status: 'up', latencyMs: 10, details: upDetails, degradedReasons: [], summary: 'All checks passing', providers: {} },
    orders: { status: 'up', latencyMs: 10, details: upDetails, degradedReasons: [], summary: 'All checks passing', providers: {} },
    payments: {
      status: 'degraded',
      latencyMs: 30,
      details: { ...upDetails, deadLetters: 3 },
      degradedReasons: ['3 dead letters'],
      summary: '3 dead letters',
      providers: { payment: 'up' },
    },
    notifications: {
      status: 'degraded',
      latencyMs: 25,
      details: { ...upDetails, providerErrorsLastHour: 6, providerErrorsByProvider: { smtp: 6 } },
      degradedReasons: ['Email provider failing: SMTP connect ECONNREFUSED 10.0.3.12:587'],
      summary: 'Email provider failing: SMTP connect ECONNREFUSED 10.0.3.12:587',
      providers: { email: 'failing', sms: 'up' },
    },
    delivery: { status: 'down', latencyMs: 3001, error: 'connect ECONNREFUSED 10.0.0.9:4005', errorCode: 'UPSTREAM_UNAVAILABLE', degradedReasons: [], summary: 'Unreachable: connect ECONNREFUSED 10.0.0.9:4005', providers: {} },
  },
};

export const ntfSummary = {
  byStatus: { QUEUED: 0, SENDING: 0, SENT: 40, DELIVERED: 2, FAILED: 5, DEAD: 7, SKIPPED: 0 },
  failedLast24h: 9,
  byChannel: { SMS: { failed: 2 }, EMAIL: { failed: 7 } },
  lastError: { channel: 'EMAIL', provider: 'smtp', message: 'SMTP connect ECONNREFUSED 10.0.3.12:587', at: '2026-10-11T07:59:00.000Z' },
};

export const exceptionJob = {
  id: 'job1aaaaaaaaaaaaaaaaaaaa',
  childOrderId: 'c1',
  checkoutGroupId: 'g1',
  restaurantId: 'r1',
  customerUserId: 'u1',
  status: 'PENDING_ASSIGNMENT',
  partnerId: null,
  partnerUserId: null,
  childOrderCode: 'TH-K7Z2MP4Q',
  checkoutCode: 'TH-K7Z2MP4Q',
  pickup: { name: 'Spice Route', address: '12 MG Road', location: { lat: 12.97, lng: 77.6 } },
  drop: { name: 'Rohit', address: '#4, HAL 2nd Stage', area: 'HAL 2nd Stage', label: 'Home', location: { lat: 12.96, lng: 77.64 } },
  dispatchRound: 3,
  exception: true,
  exceptionReason: null,
  distanceKm: 4.2,
  estimatedMinutes: 18,
  estimateSource: 'HAVERSINE',
  readyAt: null,
  failureReason: null,
  lastLocationAt: null,
  locationSimulated: false,
  statusHistory: [],
  assignedAt: null,
  createdAt: new Date(Date.now() - 6 * 60_000).toISOString(),
};

export const pendingRestaurant = {
  id: 'rest1', ownerUserId: 'o1', status: 'APPROVAL_PENDING', statusReason: null, statusHistory: [], businessName: 'Tandoor Tales Pvt', name: 'Tandoor Tales', slug: 'tandoor-tales',
  description: null, cuisines: ['north-indian'], phone: null, businessEmail: 'hi@tt.in', emailVerified: false, emailVerifiedAt: null, address: { line1: '1 Road', city: 'Bengaluru', pincode: '560001' },
  location: null, documents: [], settlement: null, commissionBps: 1500, avgPrepMinutes: 20, isDemo: false, createdAt: '2026-10-10T08:00:00.000Z', updatedAt: null,
};

export const pendingPartner = {
  id: 'part1', userId: 'pu1', name: 'Imran K.', phone: '+919300000001', vehicle: { type: 'BIKE', registrationNumber: 'KA03HX4417' }, status: 'APPROVAL_PENDING', statusReason: null,
  documents: [
    { id: 'd1', type: 'ID_PROOF', demoVerified: false, uploadedAt: '2026-10-10T08:00:00.000Z' },
    { id: 'd2', type: 'DRIVING_LICENSE', demoVerified: false, uploadedAt: '2026-10-10T08:00:00.000Z' },
    { id: 'd3', type: 'VEHICLE_RC', demoVerified: false, uploadedAt: '2026-10-10T08:00:00.000Z' },
  ],
  online: false, lastLocation: null, lastLocationAt: null, activeJobIds: [], maxActive: 2, isDemo: false, createdAt: '2026-10-10T08:00:00.000Z',
};

export const nearPartner = {
  ...pendingPartner,
  id: 'near1',
  name: 'Ravi M.',
  status: 'APPROVED',
  online: true,
  lastLocationAt: new Date().toISOString(),
  distanceToPickupKm: 1.24,
  activeJobCount: 0,
};

export const checkoutRow = {
  id: 'chk1',
  code: 'TH-DEMOMULTI',
  status: 'IN_PROGRESS',
  userId: 'u1',
  placedAt: '2026-10-11T14:12:00.000Z',
  createdAt: '2026-10-11T14:11:00.000Z',
  customer: { name: 'Prafful Sahu', phoneMasked: '+91 ••••• •3210' },
  restaurants: [
    { id: 'r1', childOrderId: 'c1', childCode: 'TH-DEMOMULTI-1', name: 'Spice Route', childStatus: 'PREPARING', deliveryStatus: null, refundStatus: 'NONE' },
    { id: 'r2', childOrderId: 'c2', childCode: 'TH-DEMOMULTI-2', name: 'Green Leaf', childStatus: 'REJECTED', deliveryStatus: null, refundStatus: 'PROCESSING' },
  ],
  totalPaise: 64620,
  paidPaise: 64620,
  refundedPaise: 0,
  refundPendingPaise: 21810,
  attention: null,
};
