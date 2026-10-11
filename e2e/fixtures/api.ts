/**
 * API fixtures: a thin HTTP client for the public API (through nginx, like the browser), demo-OTP sessions
 * (refresh cookies cached in the OS temp dir so re-runs rarely need a new OTP) and order-building helpers
 * used by the specs to set up state and to assert the server's view next to the UI.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_BASE, DEMO_OTP, PHONES, WEB_URL, sleep, type DemoUser } from './env.js';
import { resetAuthRateLimits } from './stack.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface ApiRes<T = Json> {
  status: number;
  body: T;
  setCookie: string[];
}
export interface CallOpts {
  token?: string;
  guest?: string;
  body?: unknown;
  /** Exact request bytes (sent as-is, e.g. signed webhooks); wins over `body`. */
  rawBody?: string;
  idempotencyKey?: string;
  cookie?: string;
  headers?: Record<string, string>;
}

/**
 * One API call. The whole suite shares one client IP, so a busy minute can hit the gateway's global 300/min/IP
 * limiter: a read-only GET answered 429 waits `retryAfterSec` (≤ 30 s) and retries, up to 3 times. Writes are never
 * retried here (specs that exercise limits see the 429).
 */
export async function call<T = Json>(method: string, path: string, o: CallOpts = {}): Promise<ApiRes<T>> {
  for (let attempt = 0; ; attempt++) {
    const r = await callOnce<T>(method, path, o);
    const retryAfter = Number((r.body as Json)?.error?.details?.retryAfterSec ?? 5);
    if (r.status !== 429 || method !== 'GET' || attempt >= 3 || !(retryAfter <= 30)) return r;
    await new Promise((done) => setTimeout(done, retryAfter * 1000 + 250));
  }
}

async function callOnce<T = Json>(method: string, path: string, o: CallOpts = {}): Promise<ApiRes<T>> {
  const headers: Record<string, string> = { origin: WEB_URL, 'x-requested-with': 'thali-web', accept: 'application/json', ...o.headers };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.guest) headers['x-guest-cart'] = o.guest;
  if (o.idempotencyKey) headers['idempotency-key'] = o.idempotencyKey;
  if (o.cookie) headers.cookie = o.cookie;
  const url = path.startsWith('http') ? path : API_BASE + path;
  const payload = o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
  const r = await fetch(url, { method, headers, body: payload, redirect: 'manual' });
  const text = await r.text();
  let body: Json = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: r.status, body: body as T, setCookie: r.headers.getSetCookie() };
}

export const describeRes = (r: ApiRes) => `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 600)}`;

/** Body of a successful response, else throw with the response for the report. */
export function ok<T = Json>(r: ApiRes<T>, what: string, statuses = [200, 201, 202]): T {
  if (!statuses.includes(r.status)) throw new Error(`${what}: ${describeRes(r)}`);
  return r.body;
}

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ''}`);
    }
    await sleep(opts.intervalMs ?? 1500);
  }
}

/* ------------------------------------------------------------------ sessions */

const SESSIONS_FILE = join(tmpdir(), 'thali-e2e-sessions.json');
type CookieJar = Record<string, string>; // phone -> "thali_rt=..."
const memory = new Map<string, { token: string; exp: number; userId: string }>();

function loadJar(): CookieJar {
  try {
    return existsSync(SESSIONS_FILE) ? (JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as CookieJar) : {};
  } catch {
    return {};
  }
}
function saveCookie(phone: string, r: ApiRes): void {
  const c = r.setCookie.map((s) => s.split(';')[0]!).find((s) => /^thali_rt=./.test(s));
  if (!c) return;
  const jar = loadJar();
  jar[phone] = c;
  writeFileSync(SESSIONS_FILE, JSON.stringify(jar), { mode: 0o600 });
}
function dropCookie(phone: string): void {
  const jar = loadJar();
  delete jar[phone];
  writeFileSync(SESSIONS_FILE, JSON.stringify(jar), { mode: 0o600 });
}

export function jwtClaims(token: string): { sub: string; exp: number; roles?: string[] } {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
}

export interface Session {
  phone: string;
  token: string;
  userId: string;
}

function remember(phone: string, token: string): Session {
  const c = jwtClaims(token);
  memory.set(phone, { token, exp: c.exp * 1000, userId: c.sub });
  return { phone, token, userId: c.sub };
}

/** Demo OTP request + verify (clears the auth rate-limit counters first; see resetAuthRateLimits). */
export async function otpLogin(phone: string, guestCartToken?: string): Promise<Session & { guestCartMerged: boolean | null }> {
  await resetAuthRateLimits();
  ok(await call('POST', '/auth/otp/request', { body: { phone } }), `OTP request ${phone}`);
  const v = await call('POST', '/auth/otp/verify', { body: { phone, code: DEMO_OTP, ...(guestCartToken ? { guestCartToken } : {}) } });
  const body = ok(v, `OTP verify ${phone}`);
  if (body.demoOtp !== true) throw new Error(`${phone} is not a demo phone (demoOtp missing) — check DEMO_PHONES`);
  saveCookie(phone, v);
  return { ...remember(phone, body.accessToken as string), guestCartMerged: body.guestCartMerged ?? null };
}

/** Access token for a demo user: cached token -> cached refresh cookie -> demo OTP. */
export async function login(user: DemoUser | string): Promise<Session> {
  const phone = user in PHONES ? PHONES[user as DemoUser] : user;
  const m = memory.get(phone);
  // the stack may have been restarted/re-seeded by another job: re-validate a cached token
  if (m && m.exp - Date.now() > 120_000 && (await call('GET', '/me', { token: m.token })).status === 200) {
    return { phone, token: m.token, userId: m.userId };
  }
  memory.delete(phone);
  const cookie = loadJar()[phone];
  if (cookie) {
    const r = await call('POST', '/auth/refresh', { cookie });
    if (r.status === 200 && r.body?.accessToken) {
      saveCookie(phone, r);
      return remember(phone, r.body.accessToken as string);
    }
    dropCookie(phone);
  }
  return otpLogin(phone);
}

/* ------------------------------------------------------------------ catalog */

export interface MenuItem {
  id: string;
  name: string;
  pricePaise: number;
  available: boolean;
  customizationGroups: { id: string }[];
}

export async function restaurantPage(idOrSlug: string, at?: { lat: number; lng: number }): Promise<Json> {
  const q = at ? `?lat=${at.lat}&lng=${at.lng}` : '';
  return ok(await call('GET', `/restaurants/${idOrSlug}${q}`), `GET /restaurants/${idOrSlug}`);
}

export function findItem(page: Json, name: string): MenuItem {
  const items: MenuItem[] = (page.menu ?? []).flatMap((c: Json) => c.items ?? []);
  const item = items.find((i) => i.name === name);
  if (!item) throw new Error(`item "${name}" not on ${page.restaurant?.name} — run npm run seed`);
  return item;
}

/* ------------------------------------------------------------------ cart / checkout */

export interface AddressInput {
  label?: string;
  line1: string;
  line2?: string;
  landmark?: string;
  city: string;
  pincode: string;
  location: { lat: number; lng: number };
}

export async function defaultAddress(token: string): Promise<AddressInput & { id: string }> {
  const r = ok(await call('GET', '/me/addresses', { token }), 'GET /me/addresses');
  const list: Json[] = Array.isArray(r) ? r : (r.items ?? r.addresses ?? []);
  const a = list.find((x) => x.isDefault) ?? list[0];
  if (!a) throw new Error('user has no saved address — run npm run seed');
  return { id: a.id, label: a.label ?? undefined, line1: a.line1, city: a.city, pincode: a.pincode, location: a.location, ...(a.line2 ? { line2: a.line2 } : {}) };
}

export const toAddressInput = (a: AddressInput): AddressInput => ({
  ...(a.label ? { label: a.label } : {}),
  line1: a.line1,
  ...(a.line2 ? { line2: a.line2 } : {}),
  ...(a.landmark ? { landmark: a.landmark } : {}),
  city: a.city,
  pincode: a.pincode,
  location: a.location,
});

export async function clearCart(token: string): Promise<void> {
  ok(await call('DELETE', '/cart', { token }), 'DELETE /cart', [200, 204, 404]);
}

export async function addToCart(token: string, restaurantId: string, itemId: string, quantity = 1): Promise<Json> {
  return ok(await call('POST', '/cart/items', { token, body: { restaurantId, itemId, quantity, selections: [] } }), 'POST /cart/items');
}

export interface OrderLine {
  restaurant: { id: string; slug: string; name: string };
  name: string;
  quantity?: number;
}

export interface PlacedOrder {
  checkoutId: string;
  code: string;
  intentId: string;
  /** `PaymentView` from POST /checkouts (intentId, providerOrderId, amountPaise, ...). */
  payment: Json;
  totalPaise: number;
  checkout: Json;
  /** child order by restaurant id */
  child: (restaurantId: string) => Json;
  address: AddressInput;
}

/** Fresh cart with `lines` (API) -> preview -> checkout (Idempotency-Key) -> optional demo-pay success -> PLACED. */
export async function placeOrder(token: string, lines: OrderLine[], opts: { address?: AddressInput; pay?: boolean } = {}): Promise<PlacedOrder> {
  await clearCart(token);
  for (const l of lines) {
    const page = await restaurantPage(l.restaurant.slug);
    const item = findItem(page, l.name);
    await addToCart(token, l.restaurant.id, item.id, l.quantity ?? 1);
  }
  const address = toAddressInput(opts.address ?? (await defaultAddress(token)));
  const preview = ok(await call('POST', '/cart/preview', { token, body: { address } }), 'POST /cart/preview');
  if (!preview.canCheckout) throw new Error(`cart cannot check out: ${JSON.stringify(preview.problems)}`);
  const created = ok(
    await call('POST', '/checkouts', { token, idempotencyKey: randomUUID(), body: { address, useMembership: false, expectedTotalPaise: preview.pricing.totalPaise } }),
    'POST /checkouts',
  );
  const checkoutId: string = created.checkout.id;
  if (opts.pay !== false) {
    ok(await call('POST', `/demo-pay/${created.payment.intentId}/complete`, { token, body: { outcome: 'success' } }), 'demo-pay complete'); // owner-only
    await waitFor('all child orders PLACED', async () => {
      const o = await getOrder(token, checkoutId);
      return o.checkout.children.every((c: Json) => c.status === 'PLACED') ? o : null;
    });
  }
  const o = await getOrder(token, checkoutId);
  return {
    checkoutId,
    code: created.checkout.code,
    intentId: created.payment.intentId,
    payment: created.payment,
    totalPaise: created.checkout.pricing.totalPaise,
    checkout: o.checkout,
    address,
    child: (restaurantId: string) => {
      const c = o.checkout.children.find((x: Json) => x.restaurantId === restaurantId);
      if (!c) throw new Error(`no child order for restaurant ${restaurantId}`);
      return c;
    },
  };
}

/** `GET /orders/:checkoutId` -> `{ checkout, explanations, adjustedTotals }`. */
export async function getOrder(token: string, checkoutId: string): Promise<Json> {
  return ok(await call('GET', `/orders/${checkoutId}`, { token }), `GET /orders/${checkoutId}`);
}

export async function getChild(token: string, checkoutId: string, childId: string): Promise<Json> {
  const o = await getOrder(token, checkoutId);
  return o.checkout.children.find((c: Json) => c.id === childId);
}

/* ------------------------------------------------------------------ restaurant + partner actions */

export const owner = {
  accept: async (token: string, childId: string, prepMinutes = 10) => ok(await call('POST', `/owner/orders/${childId}/accept`, { token, body: { prepMinutes } }), 'owner accept'),
  reject: async (token: string, childId: string, reason: string) => ok(await call('POST', `/owner/orders/${childId}/reject`, { token, body: { reason } }), 'owner reject'),
  preparing: async (token: string, childId: string) => ok(await call('POST', `/owner/orders/${childId}/preparing`, { token }), 'owner preparing'),
  ready: async (token: string, childId: string) => ok(await call('POST', `/owner/orders/${childId}/ready`, { token }), 'owner ready'),
  list: async (token: string, restaurantId: string) =>
    call('GET', `/owner/orders?restaurantId=${restaurantId}&limit=100`, { token }),
};

export const partner = {
  profile: async (token: string) => ok(await call('GET', '/partner/profile', { token }), 'GET /partner/profile'),
  offers: async (token: string): Promise<Json[]> => {
    const r = ok(await call('GET', '/partner/offers', { token }), 'GET /partner/offers');
    return Array.isArray(r) ? r : (r.items ?? []);
  },
  active: async (token: string): Promise<Json[]> => {
    const r = ok(await call('GET', '/deliveries/active', { token }), 'GET /deliveries/active');
    return Array.isArray(r) ? r : (r.items ?? []);
  },
  rejectOffer: (token: string, offerId: string) => call('POST', `/deliveries/offers/${offerId}/reject`, { token, body: {} }),
};

/* ------------------------------------------------------------------ stability */

/**
 * Assert a value settles on `expected` and then STAYS there: waits (up to `settleMs`) for the first matching
 * sample, then takes `samples` further samples `intervalMs` apart and fails on the first deviation.
 * Use for "exactly once" checks where a late duplicate event could still change the state.
 */
export async function expectStable<T>(
  what: string,
  fn: () => Promise<T>,
  expected: T,
  opts: { samples?: number; intervalMs?: number; settleMs?: number } = {},
): Promise<void> {
  const samples = opts.samples ?? 3;
  const intervalMs = opts.intervalMs ?? 1000;
  const want = JSON.stringify(expected);
  await waitFor(`${what} (settle)`, async () => (JSON.stringify(await fn()) === want ? true : null), { timeoutMs: opts.settleMs ?? 30_000, intervalMs });
  for (let i = 1; i <= samples; i++) {
    await sleep(intervalMs);
    const got = JSON.stringify(await fn());
    if (got !== want) throw new Error(`${what}: not stable — sample ${i}/${samples} was ${got}, expected ${want}`);
  }
}
