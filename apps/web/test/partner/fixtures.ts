/** Shared partner test fixtures (shapes mirror services/delivery views after DLV-1/2/4 and payments PAY-1). */
import { vi } from 'vitest';
import type { Offer, PartnerJob, PartnerProfile } from '../../src/features/partner/api';

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const apiError = (status: number, code: string, message = code, details?: unknown) =>
  json(status, { error: { code, message, details, requestId: 'req-1' } });

export const profile = (over: Partial<PartnerProfile> = {}): PartnerProfile => ({
  id: 'p1', userId: 'u1', name: 'Ravi Kumar', phone: null, vehicle: { type: 'SCOOTER', registrationNumber: 'KA03HX4417' }, status: 'APPROVED',
  statusReason: null, documents: [], online: true, lastLocation: null, lastLocationAt: null, activeJobIds: [], maxActive: 2, isDemo: true, createdAt: null, ...over,
});

/** An assigned job BEFORE pickup: drop is area + label only (no address, coordinates or drop link). */
export const job = (over: Partial<PartnerJob> = {}): PartnerJob => ({
  id: 'job1',
  childOrderId: 'co1',
  childOrderCode: 'TH-DEMOMULTI',
  checkoutCode: 'TH-CHK1',
  status: 'ASSIGNED',
  pickup: { name: 'Green Leaf', address: '100 Feet Rd, Indiranagar', location: { lat: 12.97, lng: 77.64 } },
  drop: { name: 'Prafful', area: 'HAL 2nd Stage', label: 'Home', address: null, location: null, addressRevealed: false, phoneMasked: '+91 ••••• •3210' },
  distanceKm: 3.2,
  estimatedMinutes: 18,
  estimateSource: 'DEMO_HAVERSINE',
  prepMinutes: 15,
  readyEta: null,
  readyAt: null,
  codeAttemptsRemaining: 5,
  navigation: { pickupUrl: 'https://www.google.com/maps/dir/?api=1&destination=12.97,77.64', dropUrl: null },
  assignedAt: '2026-10-11T07:00:00Z',
  pickedUpAt: null,
  deliveredAt: null,
  failureReason: null,
  createdAt: '2026-10-11T06:58:00Z',
  ...over,
});

/** The same job after pickup: the address is revealed. */
export const revealed = (over: Partial<PartnerJob> = {}): PartnerJob =>
  job({
    status: 'OUT_FOR_DELIVERY',
    pickedUpAt: '2026-10-11T07:20:00Z',
    drop: { name: 'Prafful', area: 'HAL 2nd Stage', label: 'Home', address: '#402, 12th Main, Indiranagar · near CMH Rd', location: { lat: 12.96, lng: 77.65 }, addressRevealed: true, phoneMasked: '+91 ••••• •3210' },
    navigation: { pickupUrl: 'https://www.google.com/maps/dir/?api=1&destination=12.97,77.64', dropUrl: 'https://www.google.com/maps/dir/?api=1&destination=12.96,77.65' },
    ...over,
  });

export const offer = (over: Partial<Offer> = {}): Offer => ({
  id: 'o1',
  jobId: 'j2',
  status: 'OFFERED',
  round: 1,
  expiresAt: new Date(Date.now() + 40_000).toISOString(),
  distanceToPickupKm: 0.8,
  batchEvaluation: { eligible: true, reasons: ['idle partner ✓'], extraMinutes: 0 },
  job: {
    childOrderId: 'co2',
    pickup: { name: 'Green Leaf', address: '100 Feet Rd, Indiranagar', location: { lat: 12.97, lng: 77.64 } },
    drop: { area: 'HAL 2nd Stage', distanceFromPickupKm: 3.2 },
    distanceKm: 3.2,
    estimatedMinutes: 18,
    estimateSource: 'GOOGLE',
    readyEta: null,
  },
  ...over,
});

export const batchedOffer = () =>
  offer({ batchEvaluation: { eligible: true, reasons: ['active 1 < max 2 ✓', 'pickup 0.8km ≤ 1.5km ✓', 'drop 1.1km ≤ 2km ✓', 'extra 8.0min ≤ 12min ✓'], extraMinutes: 8 } });

export const summary = (window?: { deliveries: number; earningsPaise: number }) => ({
  accountType: 'PARTNER', accountId: 'u1', balancePaise: 120000, availablePaise: 80000, pendingPayoutPaise: 0, paidOutPaise: 341000, holdDays: 7,
  totalsByType: {}, asOf: '2026-10-11T08:00:00Z',
  ...(window ? { window: { from: '2026-10-10T18:30:00Z', to: '2026-10-11T08:00:00Z', entriesByType: {}, ...window } } : {}),
});

export const payout = (over: Record<string, unknown> = {}) => ({
  id: 'po1', amountPaise: 341000, status: 'PAID', method: 'BANK_TRANSFER', utr: '402188331190', failureReason: null, notes: null,
  confirmedAt: '2026-10-08T06:00:00Z', createdAt: '2026-10-07T06:00:00Z', updatedAt: '2026-10-08T06:00:00Z', ...over,
});

/** Route a fetch mock by "METHOD path" (path relative to /api/v1, query stripped) → Response factory. */
export function routeFetch(routes: Record<string, (init?: RequestInit, url?: string) => Response | Promise<Response>>, fallback?: () => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^\/api\/v1/, '').split('?')[0]!;
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${path}`;
    const handler = routes[key];
    if (handler) return handler(init, url);
    return fallback ? fallback() : apiError(404, 'NOT_FOUND', `no mock for ${key}`);
  });
}

export const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, key: string) => {
  const call = fetchMock.mock.calls.find((c) => {
    const init = c[1] as RequestInit | undefined;
    return `${(init?.method ?? 'GET').toUpperCase()} ${String(c[0]).replace(/^\/api\/v1/, '').split('?')[0]}` === key;
  });
  return call ? JSON.parse(String((call[1] as RequestInit).body ?? 'null')) : undefined;
};
