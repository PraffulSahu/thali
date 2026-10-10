/** Shared fixtures and a tiny fetch router for the restaurant-area tests. Not a test file itself. */
import { vi } from 'vitest';
import type { ReactElement } from 'react';
import type { OwnerRestaurant, OwnerOrder } from '../../src/features/restaurant/api';
import { RestaurantContext } from '../../src/features/restaurant/RestaurantContext';

export function makeRestaurant(over: Partial<OwnerRestaurant> = {}): OwnerRestaurant {
  return {
    id: 'r1',
    ownerUserId: 'u1',
    status: 'APPROVED',
    statusReason: null,
    statusHistory: [],
    businessName: 'Spice Route Foods Pvt Ltd',
    name: 'Spice Route',
    slug: 'spice-route',
    description: 'Hyderabadi biryani and kebabs',
    cuisines: ['biryani'],
    phone: '+919876543210',
    businessEmail: 'owner@spiceroute.test',
    emailVerified: false,
    emailVerifiedAt: null,
    emailVerification: null,
    address: { line1: '12 MG Road', city: 'Bengaluru', pincode: '560001' },
    location: { lat: 12.9716, lng: 77.5946 },
    deliveryRadiusKm: 6,
    hours: [{ day: 1, open: '10:00', close: '22:00' }],
    timezone: 'Asia/Kolkata',
    pausedUntil: null,
    images: { cover: null, logo: null, coverUrl: null, logoUrl: null },
    documents: [],
    settlement: null,
    packagingFeePaise: 1000,
    avgPrepMinutes: 20,
    commissionBps: 1800,
    rating: null,
    isDemo: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

export function completeDraft(over: Partial<OwnerRestaurant> = {}): OwnerRestaurant {
  const doc = (type: string) => ({ id: `d-${type}`, type, key: `restaurants/r1/documents/${type}.pdf`, verified: false, uploadedAt: '2026-10-02T00:00:00.000Z' });
  return makeRestaurant({
    status: 'DRAFT',
    documents: [doc('FSSAI'), doc('GST'), doc('PAN')],
    settlement: { accountHolder: 'Spice Route Foods', ifsc: 'HDFC0001234', last4: '4321' },
    ...over,
  });
}

export function makeOrder(over: Partial<OwnerOrder> = {}): OwnerOrder {
  return {
    id: 'o1',
    code: 'TH-8K2M4Q7A',
    restaurantId: 'r1',
    status: 'PLACED',
    lines: [
      { itemId: 'i1', name: 'Chicken Biryani', isVeg: false, quantity: 2, unitPricePaise: 29900, lineTotalPaise: 59800 },
      { itemId: 'i2', name: 'Paneer Tikka', isVeg: true, quantity: 1, unitPricePaise: 24900, lineTotalPaise: 24900, note: 'Less spicy' },
    ],
    breakdown: { itemsSubtotalPaise: 84700, totalPaise: 99000 },
    placedAt: new Date().toISOString(),
    acceptBy: new Date(Date.now() + 300_000).toISOString(),
    pickupCode: '4821',
    customerContact: { name: 'Asha', phoneMasked: '+91******3210' },
    ...over,
  };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const apiError = (status: number, code: string, message: string, details?: unknown) =>
  json({ error: { code, message, details, requestId: 'req-test' } }, status);

type Handler = (req: { url: URL; body: unknown; init: RequestInit }) => Response | Promise<Response>;

export interface FetchCall {
  method: string;
  path: string;
  search: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * Stub global fetch with `[METHOD, pathRegex, handler]` routes (path without the /api/v1 prefix). Unmatched
 * requests fail the test loudly with a 599 so a missing mock is never silently ignored.
 */
export function mockApi(routes: [string, RegExp, Handler | unknown][]) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1/, '');
    let body: unknown;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ method, path, search: url.search, body, headers });
    for (const [m, re, handler] of routes) {
      if (m === method && re.test(path)) {
        const res = typeof handler === 'function' ? await (handler as Handler)({ url, body, init }) : handler instanceof Response ? handler : json(handler);
        return res instanceof Response ? res.clone() : res;
      }
    }
    return json({ error: { code: 'TEST_UNMOCKED', message: `Unmocked ${method} ${path}`, requestId: 'x' } }, 599);
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls, find: (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.path)) };
}

export function withRestaurant(restaurant: OwnerRestaurant, ui: ReactElement): ReactElement {
  return <RestaurantContext.Provider value={{ restaurant }}>{ui}</RestaurantContext.Provider>;
}
