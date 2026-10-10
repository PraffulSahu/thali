/**
 * System smoke test against the running stack (`npm run smoke`). Requires `npm run stack:up && npm run seed`.
 *
 * Drives the full multi-restaurant flow through the public API (web nginx -> gateway -> services):
 *   discovery -> guest cart with 2 restaurants -> demo OTP login (cart merge) -> checkout (Idempotency-Key)
 *   -> demo-pay success -> PLACED -> partner online + location -> restaurant A accepts / B rejects
 *   -> B refund SUCCEEDED (mock provider) -> A preparing/ready -> offer -> accept -> arrived -> pickup (code)
 *   -> start -> deliver (code) -> A DELIVERED -> checkout PARTIALLY_COMPLETED.
 * Prints PASS/FAIL per step and exits non-zero on the first failure.
 *
 * Env: SMOKE_BASE_URL (default http://localhost:5173, i.e. through nginx; http://localhost:8080 = gateway direct),
 *      SMOKE_ORIGIN (default http://localhost:5173), SMOKE_TIMEOUT_SEC (per wait, default 90).
 *
 * OTP limits (30 s resend cooldown, 5 codes/phone/hour, 10 OTP requests/min/IP) are respected: the consumer
 * logs in with a demo OTP on every run (rotating through the 3 demo consumer phones when one is cooling
 * down / exhausted); owners and the partner reuse refresh sessions cached in the OS temp dir and only fall
 * back to OTP when the cached session is gone.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.SMOKE_BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
const ORIGIN = process.env.SMOKE_ORIGIN ?? 'http://localhost:5173';
const WAIT_MS = Number(process.env.SMOKE_TIMEOUT_SEC ?? 90) * 1000;
const API = `${BASE}/api/v1`;
const SESSIONS_FILE = join(tmpdir(), 'thali-smoke-sessions.json');

const DEMO_OTP = '123456';
const CONSUMER_PHONES = ['+919000000003', '+919000000002', '+919000000001'];
const OWNER_A_PHONE = '+919100000001'; // Spice Route
const OWNER_B_PHONE = '+919100000002'; // Green Leaf
// Both APPROVED in the seed. partner2 first: the e2e suite drives partner1, and a shared stack must not have two
// test drivers competing for the same partner's offers.
const PARTNER_PHONES = ['+919200000002', '+919200000001'];
const DROP = { lat: 12.9338, lng: 77.6309 }; // Koramangala 4th Block (inside the demo service area)
const NEAR_A = { lat: 12.9349, lng: 77.6251 }; // ~100 m from Spice Route

// ------------------------------------------------------------------------------------------ http --
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Res {
  status: number;
  body: Json;
  setCookie: string[];
}
interface CallOpts {
  token?: string;
  guest?: string;
  body?: unknown;
  idempotencyKey?: string;
  cookie?: string;
}

async function call(method: string, path: string, o: CallOpts = {}): Promise<Res> {
  const headers: Record<string, string> = { origin: ORIGIN, 'x-requested-with': 'thali-web', accept: 'application/json' };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.guest) headers['x-guest-cart'] = o.guest;
  if (o.idempotencyKey) headers['idempotency-key'] = o.idempotencyKey;
  if (o.cookie) headers.cookie = o.cookie;
  const r = await fetch(API + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await r.text();
  let body: Json = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: r.status, body, setCookie: r.headers.getSetCookie() };
}

class StepError extends Error {}
const describe = (r: Res) => `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 400)}`;
function expectOk(r: Res, what: string, statuses = [200, 201]): Json {
  if (!statuses.includes(r.status)) throw new StepError(`${what}: ${describe(r)}`);
  return r.body;
}
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new StepError(msg);
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, intervalMs = 1500): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new StepError(`timed out after ${WAIT_MS / 1000}s waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ''}`);
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------------------- steps --
let stepNo = 0;
const results: { n: number; name: string; ok: boolean; ms: number; info: string }[] = [];
async function step<T>(name: string, fn: () => Promise<T>, info?: (v: T) => string): Promise<T> {
  const n = ++stepNo;
  const t0 = Date.now();
  try {
    const v = await fn();
    const detail = info ? info(v) : '';
    results.push({ n, name, ok: true, ms: Date.now() - t0, info: detail });
    console.log(`PASS ${String(n).padStart(2)}  ${name}${detail ? `  — ${detail}` : ''}  (${Date.now() - t0} ms)`);
    return v;
  } catch (e) {
    results.push({ n, name, ok: false, ms: Date.now() - t0, info: (e as Error).message });
    console.log(`FAIL ${String(n).padStart(2)}  ${name}  — ${(e as Error).message}`);
    summary();
    process.exit(1);
  }
}
function summary() {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nsmoke: ${results.length - failed}/${results.length} steps passed${failed ? `, ${failed} failed` : ''}`);
}

// -------------------------------------------------------------------------------------- sessions --
type Sessions = Record<string, string>; // phone -> refresh cookie ("thali_rt=...")
const loadSessions = (): Sessions => {
  try {
    return existsSync(SESSIONS_FILE) ? (JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as Sessions) : {};
  } catch {
    return {};
  }
};
const sessions = loadSessions();
const saveSessions = () => writeFileSync(SESSIONS_FILE, JSON.stringify(sessions), { mode: 0o600 });
function rememberCookie(phone: string, r: Res) {
  const c = r.setCookie.map((s) => s.split(';')[0]!).find((s) => s.startsWith('thali_rt='));
  if (c && c !== 'thali_rt=') {
    sessions[phone] = c;
    saveSessions();
  }
}

/** Demo OTP login; waits out the resend cooldown. Returns null when the phone's hourly quota is exhausted. */
async function otpLogin(phone: string, guestCartToken?: string): Promise<{ token: string; merged: boolean | null; userId: string } | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const req = await call('POST', '/auth/otp/request', { body: { phone } });
    if (req.status === 202 || req.status === 200) break;
    if (req.status === 429) {
      const retry = Number(req.body?.error?.details?.retryAfterSec ?? req.body?.error?.details?.resendAfterSec ?? 0);
      if (!retry || retry > 60) return null; // hourly quota: try another phone
      console.log(`      (OTP cooldown for ${phone}: waiting ${retry}s)`);
      await sleep((retry + 1) * 1000);
      continue;
    }
    throw new StepError(`OTP request ${phone}: ${describe(req)}`);
  }
  const v = await call('POST', '/auth/otp/verify', { body: { phone, code: DEMO_OTP, ...(guestCartToken ? { guestCartToken } : {}) } });
  if (v.status === 429) return null;
  const body = expectOk(v, `OTP verify ${phone}`);
  rememberCookie(phone, v);
  const claims = JSON.parse(Buffer.from(String(body.accessToken).split('.')[1]!, 'base64url').toString()) as { sub: string };
  return { token: body.accessToken, merged: body.guestCartMerged ?? null, userId: claims.sub };
}

/** Reuse a cached refresh session (no OTP), else demo OTP. */
async function sessionLogin(phone: string): Promise<string> {
  const t = await trySessionLogin(phone);
  if (!t) throw new StepError(`cannot log in ${phone}: OTP quota exhausted for this hour (and no cached session)`);
  return t;
}
async function trySessionLogin(phone: string): Promise<string | null> {
  const cookie = sessions[phone];
  if (cookie) {
    const r = await call('POST', '/auth/refresh', { cookie });
    if (r.status === 200 && r.body?.accessToken) {
      rememberCookie(phone, r);
      return r.body.accessToken as string;
    }
    delete sessions[phone];
    saveSessions();
  }
  const l = await otpLogin(phone);
  return l ? l.token : null;
}

// ------------------------------------------------------------------------------------------ main --
interface Pick {
  restaurantId: string;
  itemId: string;
  name: string;
  selections: { groupId: string; optionIds: string[] }[];
}

/** First available item; satisfies required groups with their first available options, adds one optional add-on. */
function pickItem(restaurantId: string, page: Json, prefer: RegExp): Pick {
  const items: Json[] = (page.menu ?? page.categories ?? []).flatMap((c: Json) => c.items ?? []);
  const item = items.find((i) => prefer.test(i.name) && i.available !== false) ?? items.find((i) => i.available !== false);
  check(item, `no available item on restaurant ${restaurantId}`);
  const selections = (item.customizationGroups ?? [])
    .map((g: Json) => {
      const avail = (g.options ?? []).filter((o: Json) => o.available !== false);
      const n = Math.max(g.minSelect, g.minSelect === 0 && avail.length ? 1 : 0);
      return { groupId: g.id, optionIds: avail.slice(0, Math.min(n, g.maxSelect)).map((o: Json) => o.id) };
    })
    .filter((s: { optionIds: string[] }) => s.optionIds.length);
  return { restaurantId, itemId: item.id, name: item.name, selections };
}

async function main() {
  console.log(`smoke: ${API} (origin ${ORIGIN})\n`);

  await step('platform meta (demo mode)', async () => {
    const meta = expectOk(await call('GET', '/meta'), 'GET /meta');
    check(meta.mode === 'demo', `expected demo mode, got ${meta.mode}`);
    return meta;
  }, (m) => `mode=${m.mode}`);

  const { a, b } = await step('discovery lists both demo restaurants (deliverable, open)', async () => {
    const d = expectOk(await call('GET', `/discovery/restaurants?lat=${DROP.lat}&lng=${DROP.lng}`), 'discovery');
    const items: Json[] = d.items ?? [];
    const a = items.find((r) => r.name === 'Spice Route');
    const b = items.find((r) => r.name === 'Green Leaf');
    check(a && b, `Spice Route and Green Leaf not both listed (got ${items.map((r) => r.name).join(', ') || 'none'}) — run npm run seed`);
    check(a.open !== false && b.open !== false, 'a demo restaurant is closed');
    return { a, b };
  }, (v) => `A=${v.a.name} (${v.a.id}), B=${v.b.name} (${v.b.id})`);

  const [pickA, pickB] = await step('restaurant menus (items with customizations)', async () => {
    const pa = expectOk(await call('GET', `/restaurants/${a.id}?lat=${DROP.lat}&lng=${DROP.lng}`), 'restaurant A page');
    const pb = expectOk(await call('GET', `/restaurants/${b.id}?lat=${DROP.lat}&lng=${DROP.lng}`), 'restaurant B page');
    return [pickItem(a.id, pa, /biryani/i), pickItem(b.id, pb, /dosa/i)] as const;
  }, ([x, y]) => `A: ${x.name} (${x.selections.length} selection groups), B: ${y.name}`);

  const guest = await step('guest cart token', async () => {
    const g = expectOk(await call('POST', '/cart/guest'), 'POST /cart/guest');
    check(typeof g.guestToken === 'string', 'no guestToken');
    return g.guestToken as string;
  });

  await step('guest cart with 2 restaurants', async () => {
    for (const p of [pickA, pickB]) {
      expectOk(await call('POST', '/cart/items', { guest, body: { restaurantId: p.restaurantId, itemId: p.itemId, quantity: 1, selections: p.selections } }), `add ${p.name}`);
    }
    const cart = expectOk(await call('GET', '/cart', { guest }), 'GET guest cart');
    check(cart.restaurantCount === 2, `expected 2 restaurants in cart, got ${cart.restaurantCount}`);
    return cart;
  }, (c) => `${c.itemCount} items, subtotal ₹${(c.subtotalPaise / 100).toFixed(2)}`);

  const consumer = await step('demo OTP login (consumer) with guest cart merge', async () => {
    for (const phone of CONSUMER_PHONES) {
      const l = await otpLogin(phone, guest);
      if (l) return { ...l, phone };
      console.log(`      (${phone}: OTP quota exhausted, trying the next demo consumer)`);
    }
    throw new StepError('all demo consumer phones exhausted their hourly OTP quota');
  }, (c) => `${c.phone} userId=${c.userId} guestCartMerged=${c.merged}`);

  await step('merged cart belongs to the user (2 restaurants)', async () => {
    let cart = expectOk(await call('GET', '/cart', { token: consumer.token }), 'GET user cart');
    if (cart.restaurantCount !== 2) {
      // best-effort merge at login failed: merge explicitly
      expectOk(await call('POST', '/cart/merge', { token: consumer.token, body: { guestToken: guest } }), 'POST /cart/merge');
      cart = expectOk(await call('GET', '/cart', { token: consumer.token }), 'GET user cart');
    }
    check(cart.ownerType === 'USER' && cart.restaurantCount === 2, `user cart: ownerType=${cart.ownerType} restaurants=${cart.restaurantCount}`);
    return cart;
  }, (c) => `cartVersion ${c.cartVersion}, ${c.itemCount} items`);

  const address = { label: 'Smoke', line1: '1, 4th Block, Koramangala', city: 'Bengaluru', pincode: '560034', location: DROP };
  const preview = await step('checkout preview (pricing per restaurant)', async () => {
    const p = expectOk(await call('POST', '/cart/preview', { token: consumer.token, body: { address } }), 'POST /cart/preview');
    check(p.canCheckout && !(p.problems ?? []).length, `preview problems: ${JSON.stringify(p.problems)}`);
    return p;
  }, (p) => `${p.children?.length} children, total ₹${(p.pricing.totalPaise / 100).toFixed(2)}, canCheckout=${p.canCheckout}`);

  const idemKey = randomUUID();
  const created = await step('create checkout (Idempotency-Key)', async () => {
    const body = { address, expectedTotalPaise: preview.pricing.totalPaise };
    const r = expectOk(await call('POST', '/checkouts', { token: consumer.token, body, idempotencyKey: idemKey }), 'POST /checkouts');
    check(r.checkout?.children?.length === 2, `expected 2 child orders, got ${r.checkout?.children?.length}`);
    check(r.payment?.intentId, `no payment intent: ${JSON.stringify(r.payment)}`);
    const replay = await call('POST', '/checkouts', { token: consumer.token, body, idempotencyKey: idemKey });
    check([200, 201].includes(replay.status) && replay.body?.checkout?.id === r.checkout.id, `idempotent replay returned a different result: ${describe(replay)}`);
    return r;
  }, (r) => `${r.checkout.code} ${r.checkout.status}, ₹${(r.checkout.pricing.totalPaise / 100).toFixed(2)}, intent ${r.payment.intentId} (${r.payment.provider}), replay = same checkout`);
  const checkoutId: string = created.checkout.id;
  const childA = created.checkout.children.find((c: Json) => c.restaurantId === a.id);
  const childB = created.checkout.children.find((c: Json) => c.restaurantId === b.id);

  await step('demo pay: success', async () => {
    const r = expectOk(await call('POST', `/demo-pay/${created.payment.intentId}/complete`, { body: { outcome: 'success' } }), 'demo-pay complete');
    check(r.status === 'CAPTURED', `payment status ${r.status}`);
    return r;
  }, (r) => `payment ${r.status} (simulated=${r.simulated})`);

  const orderUrl = `/orders/${checkoutId}`;
  const order = () => call('GET', orderUrl, { token: consumer.token }).then((r) => expectOk(r, 'GET order'));
  const child = (o: Json, id: string) => (o.children ?? o.checkout?.children ?? []).find((c: Json) => c.id === id);
  const checkoutOf = (o: Json) => o.checkout ?? o;

  await step('both child orders PLACED after capture', () =>
    waitFor('PLACED', async () => {
      const o = await order();
      return child(o, childA.id)?.status === 'PLACED' && child(o, childB.id)?.status === 'PLACED' ? o : null;
    }), (o) => `checkout ${checkoutOf(o).status}`);

  const ownerA = await step('owner A (Spice Route) signs in', () => sessionLogin(OWNER_A_PHONE), () => OWNER_A_PHONE);
  const ownerB = await step('owner B (Green Leaf) signs in', () => sessionLogin(OWNER_B_PHONE), () => OWNER_B_PHONE);

  // The partner is online before A accepts, so the first dispatch round (at order.accepted) already includes them
  // (a partner who comes online later waits for the next round, OFFER_TTL_SEC).
  const { partner, partnerPhone } = await step('partner signs in', async () => {
    for (const phone of PARTNER_PHONES) {
      const t = await trySessionLogin(phone);
      if (t) return { partner: t, partnerPhone: phone };
      console.log(`      (${phone}: no session and OTP quota exhausted, trying the next demo partner)`);
    }
    throw new StepError('no demo partner can sign in (OTP quota exhausted, no cached sessions)');
  }, (v) => v.partnerPhone);

  await step('partner online + location ping near restaurant A', async () => {
    const on = await call('POST', '/partner/online', { token: partner, body: NEAR_A });
    expectOk(on, 'partner online');
    await sleep(3100); // 1 ping / 3 s
    expectOk(await call('POST', '/partner/location', { token: partner, body: { ...NEAR_A, accuracyM: 10 } }), 'location ping');
    return on.body;
  }, (p) => `status ${p.status ?? '?'} online=${p.online ?? '?'}`);

  const pickupCode = await step('restaurant A accepts', async () => {
    const r = expectOk(await call('POST', `/owner/orders/${childA.id}/accept`, { token: ownerA, body: { prepMinutes: 15 } }), 'accept A');
    check(r.status === 'ACCEPTED', `A is ${r.status}`);
    return r.pickupCode as string;
  }, (code) => `pickup code ${code}`);

  await step('restaurant B rejects', async () => {
    const r = expectOk(await call('POST', `/owner/orders/${childB.id}/reject`, { token: ownerB, body: { reason: 'Out of key ingredients (smoke test)' } }), 'reject B');
    check(r.status === 'REJECTED', `B is ${r.status}`);
    return r;
  });

  await step('B refund SUCCEEDED (mock provider)', () =>
    waitFor('B refund SUCCEEDED', async () => {
      const c = child(await order(), childB.id);
      return c?.refundStatus === 'SUCCEEDED' ? c : null;
    }), (c) => `refunded ₹${((c.refundedPaise ?? 0) / 100).toFixed(2)} of ₹${(c.breakdown.totalPaise / 100).toFixed(2)}`);

  await step('restaurant A preparing → ready for pickup', async () => {
    expectOk(await call('POST', `/owner/orders/${childA.id}/preparing`, { token: ownerA }), 'A preparing');
    const r = expectOk(await call('POST', `/owner/orders/${childA.id}/ready`, { token: ownerA }), 'A ready');
    check(r.status === 'READY_FOR_PICKUP', `A is ${r.status}`);
    return r;
  });

  const offer = await step('dispatch offers the job for A to the partner', () =>
    waitFor('offer', async () => {
      const r = expectOk(await call('GET', '/partner/offers', { token: partner }), 'GET offers');
      return (r.items ?? r).find?.((o: Json) => o.childOrderId === childA.id || o.job?.childOrderId === childA.id) ?? null;
    }, 2500), (o) => `offer ${o.id ?? o.offerId}`);

  const job = await step('partner accepts the offer', async () => {
    const r = expectOk(await call('POST', `/deliveries/offers/${offer.id ?? offer.offerId}/accept`, { token: partner }), 'accept offer');
    return r.job;
  }, (j) => `job ${j.id} ${j.status}`);

  await step('arrived at restaurant → pickup with the restaurant code', async () => {
    expectOk(await call('POST', `/deliveries/${job.id}/arrived`, { token: partner }), 'arrived');
    const r = expectOk(await call('POST', `/deliveries/${job.id}/pickup`, { token: partner, body: { code: pickupCode } }), 'pickup');
    check(r.status === 'PICKED_UP', `job is ${r.status}`);
    return r;
  });

  await step('start delivery', async () => {
    const r = expectOk(await call('POST', `/deliveries/${job.id}/start`, { token: partner }), 'start');
    check(r.status === 'OUT_FOR_DELIVERY', `job is ${r.status}`);
    return r;
  });

  await step('deliver with the customer code', async () => {
    const code = child(await order(), childA.id)?.deliveryCode;
    check(code, 'customer view has no deliveryCode');
    const r = expectOk(await call('POST', `/deliveries/${job.id}/deliver`, { token: partner, body: { code } }), 'deliver');
    check(r.status === 'DELIVERED', `job is ${r.status}`);
    return r;
  });

  const final = await step('child A DELIVERED, checkout PARTIALLY_COMPLETED', () =>
    waitFor('A DELIVERED + PARTIALLY_COMPLETED', async () => {
      const o = await order();
      return child(o, childA.id)?.status === 'DELIVERED' && checkoutOf(o).status === 'PARTIALLY_COMPLETED' ? o : null;
    }), (o) => `${checkoutOf(o).code}: A ${child(o, childA.id).status}, B ${child(o, childB.id).status}/${child(o, childB.id).refundStatus}, checkout ${checkoutOf(o).status}`);

  await step('partner goes offline', async () => {
    const r = await call('POST', '/partner/offline', { token: partner });
    // Another driver (e.g. the e2e suite on the same stack) may have handed this partner a job meanwhile.
    if (r.status === 409 && r.body?.error?.code === 'PARTNER_HAS_ACTIVE_JOBS') return 'stays online: holds another active job (not from this run)';
    expectOk(r, 'offline');
    return 'offline';
  }, (v) => v);

  void final;
  summary();
}

main().catch((e: unknown) => {
  console.log(`FAIL     unexpected error — ${(e as Error).stack ?? String(e)}`);
  summary();
  process.exit(1);
});
