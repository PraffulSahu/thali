/**
 * Live demo traffic through the public API (`npm run demo:traffic -- --orders 6`). Requires `npm run seed`
 * (Bengaluru dataset) on a running stack in demo mode.
 *
 * Places N real orders from generated consumers living around one area (default Indiranagar), as a customer
 * would: discovery → cart → preview → checkout (Idempotency-Key per run) → demo-pay success. Then the generated
 * owners (demo OTP 123456 via DEMO_PHONE_PREFIXES) and two generated partners walk them to a mix of states so
 * the owner kanban, tracking and the admin overview are alive:
 *   New (left PLACED; the accept window will time it out) · Preparing · Ready (dispatch keeps offering it) ·
 *   On the way (partner accepted, picked up with the restaurant code, started) · Delivered (customer code).
 * Partners go online near the restaurant before it accepts (so the first dispatch round includes them) and
 * back offline at the end when they hold no active job.
 *
 *   npm run demo:traffic -- --orders 6 [--area "Koramangala 5th Block"]
 * Env: DEMO_BASE_URL (default http://localhost:5173, through nginx; http://localhost:8080 = gateway direct),
 *      DEMO_ORIGIN (default http://localhost:5173).
 * OTP budget: identity allows 20 OTP requests / IP / hour, so the script reuses a small pool of people (4
 * consumers, ≤3 owners, 2 partners) and caches their refresh sessions in the OS temp dir; re-runs need no OTP.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pricing from '@thali/pricing';
import { buildBlrWorld, haversineKm, type BlrConsumer, type BlrPartner, type BlrWorld } from '@thali/contracts/seed-blr';

const BASE = (process.env.DEMO_BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
const ORIGIN = process.env.DEMO_ORIGIN ?? 'http://localhost:5173';
const API = `${BASE}/api/v1`;
const SESSIONS_FILE = join(tmpdir(), 'thali-demo-traffic-sessions.json');
const DEMO_OTP = '123456';
const WAIT_MS = 90_000;

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Res {
  status: number;
  body: Json;
  setCookie: string[];
}
async function call(method: string, path: string, o: { token?: string; body?: unknown; idempotencyKey?: string; cookie?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { origin: ORIGIN, 'x-requested-with': 'thali-web', accept: 'application/json' };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.idempotencyKey) headers['idempotency-key'] = o.idempotencyKey;
  if (o.cookie) headers.cookie = o.cookie;
  const r = await fetch(API + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await r.text();
  let body: Json = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* text */
  }
  return { status: r.status, body, setCookie: r.headers.getSetCookie() };
}
const describe = (r: Res) => `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 300)}`;
function ok(r: Res, what: string): Json {
  if (r.status !== 200 && r.status !== 201 && r.status !== 202) throw new Error(`${what}: ${describe(r)}`);
  return r.body;
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, everyMs = 1500): Promise<T> {
  const until = Date.now() + WAIT_MS;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------------------- sessions --
const sessions: Record<string, string> = (() => {
  try {
    return existsSync(SESSIONS_FILE) ? (JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as Record<string, string>) : {};
  } catch {
    return {};
  }
})();
function remember(phone: string, r: Res) {
  const c = r.setCookie.map((s) => s.split(';')[0]!).find((s) => s.startsWith('thali_rt='));
  if (c && c !== 'thali_rt=') {
    sessions[phone] = c;
    writeFileSync(SESSIONS_FILE, JSON.stringify(sessions), { mode: 0o600 });
  }
}
async function login(phone: string): Promise<string> {
  const cookie = sessions[phone];
  if (cookie) {
    const r = await call('POST', '/auth/refresh', { cookie });
    if (r.status === 200 && r.body?.accessToken) {
      remember(phone, r);
      return r.body.accessToken as string;
    }
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const req = await call('POST', '/auth/otp/request', { body: { phone } });
    if (req.status === 200 || req.status === 202) break;
    const retry = Number(req.body?.error?.details?.retryAfterSec ?? req.body?.error?.details?.resendAfterSec ?? 0);
    if (req.status === 429 && retry > 0 && retry <= 65) {
      log(`    (OTP throttled for ${phone}: waiting ${retry}s)`);
      await sleep((retry + 1) * 1000);
      continue;
    }
    throw new Error(`OTP request ${phone}: ${describe(req)} (identity allows 20 OTP requests per IP per hour)`);
  }
  const v = await call('POST', '/auth/otp/verify', { body: { phone, code: DEMO_OTP } });
  const body = ok(v, `OTP verify ${phone}`);
  remember(phone, v);
  return body.accessToken as string;
}

const log = (s: string) => process.stdout.write(`${s}\n`);

// ------------------------------------------------------------------------------------------- flow --
type Target = 'new' | 'preparing' | 'ready' | 'ontheway' | 'delivered';
const CYCLE: Target[] = ['new', 'preparing', 'ready', 'ontheway', 'delivered', 'preparing', 'ontheway', 'ready'];

interface Pick {
  restaurantId: string;
  itemId: string;
  name: string;
  selections: { groupId: string; optionIds: string[] }[];
}
function pickItems(restaurantId: string, page: Json, n: number): Pick[] {
  const items: Json[] = (page.menu ?? page.categories ?? []).flatMap((c: Json) => c.items ?? []).filter((i: Json) => i.available !== false && !i.soldOut);
  const ordered = [...items.filter((i) => i.featured), ...items.filter((i) => !i.featured)];
  const chosen = ordered.sort(() => Math.random() - 0.5).slice(0, n);
  return chosen.map((item) => ({
    restaurantId,
    itemId: item.id,
    name: item.name,
    selections: (item.customizationGroups ?? [])
      .map((g: Json) => {
        const avail = (g.options ?? []).filter((o: Json) => o.available !== false);
        return { groupId: g.id, optionIds: g.minSelect > 0 ? avail.slice(0, Math.min(g.minSelect, g.maxSelect)).map((o: Json) => o.id) : [] };
      })
      .filter((s: { optionIds: string[] }) => s.optionIds.length),
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const ni = args.indexOf('--orders');
  const N = Math.max(1, Math.min(20, ni >= 0 ? Number(args[ni + 1]) : 6));
  const ai = args.indexOf('--area');
  const runId = Date.now().toString(36);
  const w: BlrWorld = buildBlrWorld({ pricing });
  const areaName = ai >= 0 ? args[ai + 1]! : 'Indiranagar';
  const area = w.data.localities.find((l) => l.name.toLowerCase() === areaName.toLowerCase());
  if (!area) throw new Error(`unknown area "${areaName}" (a name from scripts/seed-data/localities.json)`);
  log(`demo-traffic: ${N} orders around ${area.name} via ${API} (run ${runId})`);

  const meta = ok(await call('GET', '/meta'), 'GET /meta');
  if (meta.mode !== 'demo') throw new Error(`stack is not in demo mode (${meta.mode})`);

  // people: 4 consumers living closest to the area, 2 approved partners based closest to it
  const consumers: BlrConsumer[] = [...w.consumers].sort((a, b) => haversineKm(a.addresses[0]!.location, area) - haversineKm(b.addresses[0]!.location, area)).slice(0, 4);
  const partners: BlrPartner[] = w.partners.filter((p) => p.status === 'APPROVED' && p.vehicle.type !== 'BICYCLE').sort((a, b) => haversineKm(a.base, area) - haversineKm(b.base, area)).slice(0, 2);
  const restaurantOwner = new Map(w.restaurants.map((r) => [r.id, w.owners[r.ownerK]!]));
  const restaurantAt = new Map(w.restaurants.map((r) => [r.id, r.location]));

  // restaurants that are open now and deliver to the first consumer: ≤ 3 distinct owners
  const home0 = consumers[0]!.addresses[0]!;
  const disco = ok(await call('GET', `/discovery/restaurants?lat=${home0.location.lat}&lng=${home0.location.lng}&limit=50`), 'discovery');
  const open = (disco.items as Json[]).filter((r) => r.open !== false && restaurantOwner.has(r.id));
  const owners = new Map<string, string[]>(); // owner phone -> restaurant ids
  for (const r of open) {
    const o = restaurantOwner.get(r.id)!;
    if (!owners.has(o.phone) && owners.size >= 3) continue;
    owners.set(o.phone, [...(owners.get(o.phone) ?? []), r.id]);
  }
  const restaurants = [...owners.values()].map((ids) => ids[0]!);
  if (!restaurants.length) throw new Error(`no generated restaurant is open near ${area.name} right now (try another --area)`);
  log(`  restaurants: ${restaurants.map((id) => open.find((r) => r.id === id)?.name).join(', ')}`);
  log(`  consumers:   ${consumers.map((c) => `${c.name} ${c.phone}`).join(', ')}`);
  log(`  partners:    ${partners.map((p) => `${p.name} ${p.phone} (${p.vehicle.registrationNumber})`).join(', ')}`);

  const tokens = new Map<string, string>();
  const tokenFor = async (phone: string) => {
    if (!tokens.has(phone)) tokens.set(phone, await login(phone));
    return tokens.get(phone)!;
  };
  const restaurantById = new Map(open.map((r) => [r.id as string, r]));

  // partners: capacity check (MAX_ACTIVE_DELIVERIES) from their active jobs
  const partnerActive = new Map<string, number>();
  for (const p of partners) {
    const t = await tokenFor(p.phone);
    const a = await call('GET', '/deliveries/active', { token: t });
    partnerActive.set(p.phone, a.status === 200 ? ((a.body?.items ?? a.body ?? []) as Json[]).length : 0);
  }

  const results: { code: string; restaurant: string; state: string }[] = [];
  for (let i = 0; i < N; i++) {
    let target = CYCLE[i % CYCLE.length]!;
    const consumer = consumers[i % consumers.length]!;
    const restId = restaurants[i % restaurants.length]!;
    const rest = restaurantById.get(restId)!;
    const ownerPhone = restaurantOwner.get(restId)!.phone;
    const addr = consumer.addresses[0]!;
    const address = { label: addr.label, line1: addr.line1, ...(addr.line2 ? { line2: addr.line2 } : {}), locality: addr.locality, city: addr.city, pincode: addr.pincode, location: addr.location };
    log(`\n  [${i + 1}/${N}] ${consumer.name} → ${rest.name} (target: ${target})`);
    try {
      const ct = await tokenFor(consumer.phone);
      await call('DELETE', '/cart', { token: ct });
      const page = ok(await call('GET', `/restaurants/${restId}?lat=${addr.location.lat}&lng=${addr.location.lng}`), 'restaurant page');
      for (const p of pickItems(restId, page, 1 + Math.floor(Math.random() * 3))) {
        ok(await call('POST', '/cart/items', { token: ct, body: { restaurantId: p.restaurantId, itemId: p.itemId, quantity: 1, selections: p.selections } }), `add ${p.name}`);
      }
      const preview = ok(await call('POST', '/cart/preview', { token: ct, body: { address } }), 'preview');
      if (!preview.canCheckout) throw new Error(`cannot check out: ${JSON.stringify(preview.problems)}`);
      const created = ok(await call('POST', '/checkouts', { token: ct, body: { address, expectedTotalPaise: preview.pricing.totalPaise }, idempotencyKey: `demo-traffic-${runId}-${i}` }), 'checkout');
      ok(await call('POST', `/demo-pay/${created.payment.intentId}/complete`, { token: ct, body: { outcome: 'success' } }), 'demo-pay');
      const checkoutId = created.checkout.id as string;
      const child = created.checkout.children[0];
      const childId = child.id as string;
      const view = () => call('GET', `/orders/${checkoutId}`, { token: ct }).then((r) => ok(r, 'order view'));
      const childOf = (o: Json) => (o.children ?? o.checkout?.children ?? []).find((c: Json) => c.id === childId);
      await waitFor('PLACED', async () => childOf(await view())?.status === 'PLACED');
      log(`    placed ${created.checkout.code} ₹${(preview.pricing.totalPaise / 100).toFixed(2)} (paid, demo)`);
      if (target === 'new') {
        results.push({ code: created.checkout.code, restaurant: rest.name, state: 'New (awaiting restaurant)' });
        continue;
      }
      // a partner for the delivery targets: online near the restaurant before the restaurant accepts
      let partner: BlrPartner | undefined;
      if (target === 'ontheway' || target === 'delivered') {
        partner = partners.find((p) => (partnerActive.get(p.phone) ?? 0) < 2);
        if (!partner) {
          log('    (both partners at capacity: stopping at Ready)');
          target = 'ready';
        } else {
          const pt = await tokenFor(partner.phone);
          const at = restaurantAt.get(restId)!;
          ok(await call('POST', '/partner/online', { token: pt, body: at }), 'partner online');
          await sleep(3100);
          ok(await call('POST', '/partner/location', { token: pt, body: { ...at, accuracyM: 12 } }), 'partner location');
        }
      }
      const ot = await tokenFor(ownerPhone);
      const accepted = ok(await call('POST', `/owner/orders/${childId}/accept`, { token: ot, body: { prepMinutes: 15 + Math.floor(Math.random() * 10) } }), 'owner accept');
      ok(await call('POST', `/owner/orders/${childId}/preparing`, { token: ot }), 'owner preparing');
      if (target === 'preparing') {
        results.push({ code: created.checkout.code, restaurant: rest.name, state: 'Preparing' });
        continue;
      }
      ok(await call('POST', `/owner/orders/${childId}/ready`, { token: ot }), 'owner ready');
      if (target === 'ready') {
        results.push({ code: created.checkout.code, restaurant: rest.name, state: 'Ready for pickup' });
        continue;
      }
      const pt = await tokenFor(partner!.phone);
      const offer = await waitFor('dispatch offer', async () => {
        await call('POST', '/partner/location', { token: pt, body: { ...restaurantAt.get(restId)!, accuracyM: 12 } });
        const r = ok(await call('GET', '/partner/offers', { token: pt }), 'offers');
        return ((r.items ?? r) as Json[]).find?.((o: Json) => o.childOrderId === childId || o.job?.childOrderId === childId) ?? null;
      }, 3200);
      const job = ok(await call('POST', `/deliveries/offers/${offer.id ?? offer.offerId}/accept`, { token: pt }), 'accept offer').job;
      partnerActive.set(partner!.phone, (partnerActive.get(partner!.phone) ?? 0) + 1);
      ok(await call('POST', `/deliveries/${job.id}/arrived`, { token: pt }), 'arrived');
      ok(await call('POST', `/deliveries/${job.id}/pickup`, { token: pt, body: { code: accepted.pickupCode } }), 'pickup');
      ok(await call('POST', `/deliveries/${job.id}/start`, { token: pt }), 'start');
      if (target === 'ontheway') {
        results.push({ code: created.checkout.code, restaurant: rest.name, state: `On the way (${partner!.name})` });
        continue;
      }
      const code = childOf(await view())?.deliveryCode;
      ok(await call('POST', `/deliveries/${job.id}/deliver`, { token: pt, body: { code } }), 'deliver');
      partnerActive.set(partner!.phone, (partnerActive.get(partner!.phone) ?? 1) - 1);
      results.push({ code: created.checkout.code, restaurant: rest.name, state: `Delivered (${partner!.name})` });
    } catch (e) {
      log(`    FAILED: ${(e as Error).message}`);
      results.push({ code: '-', restaurant: rest.name, state: `failed: ${(e as Error).message.slice(0, 120)}` });
    }
  }

  for (const p of partners) {
    if ((partnerActive.get(p.phone) ?? 0) > 0) continue;
    await call('POST', '/partner/offline', { token: await tokenFor(p.phone) });
  }
  log('\n=== demo-traffic summary');
  for (const r of results) log(`  ${r.code.padEnd(12)} ${r.state.padEnd(34)} ${r.restaurant}`);
  const failed = results.filter((r) => r.state.startsWith('failed')).length;
  log(`  ${results.length - failed}/${results.length} orders placed (run ${runId}${failed ? `, ${failed} failed` : ''})`);
  process.exit(failed === results.length ? 1 : 0);
}

main().catch((e: unknown) => {
  process.stderr.write(`demo-traffic: ${(e as Error).message}\n`);
  process.exit(1);
});
