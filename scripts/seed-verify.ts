/**
 * Cross-service consistency checks over the seeded databases (`npx tsx scripts/seed-verify.ts`). Prints the
 * document count of every collection and exits non-zero when a check fails:
 *  - every rating belongs to a DELIVERED child order of the same restaurant and customer
 *  - restaurants.ratingSum / ratingCount = the restaurant's ratings exactly (the 4 named demo restaurants carry
 *    pre-existing headline numbers without rating documents, so they are reported, not checked)
 *  - coupons.usedCount = the coupon's REDEEMED redemptions
 *  - every ledger account balance ≥ 0
 *  - every DELIVERED child has a DELIVERED delivery job and a captured payment intent for its checkout, and its
 *    restaurant ORDER_EARNING posting; every REJECTED / CANCELLED child has SUCCEEDED refunds = refundedPaise
 *  - checkout totals = Σ child totals; memberships.freeDeliveriesUsed = Σ usage; jobs reference real partners
 *  - realism: no cover photo twice within a locality; no two branches of one brand (owner + name) in a locality;
 *    live Discover (gateway, first two pages at Indiranagar / Koramangala / HSR) repeats no cover and no restaurant
 *    name (skipped with a note when the gateway is unreachable; SEED_VERIFY_API, default http://localhost:8080)
 *
 *   npx tsx scripts/seed-verify.ts                    # docker stack: runs inside the orders container as Mongo root
 *   npx tsx scripts/seed-verify.ts --uri <mongo-uri> [--db-prefix thali_]   # any reachable Mongo (e.g. infra / tests)
 */
import { spawn } from 'node:child_process';
import { ROOT, mergedEnv } from './lib/dotenv.js';

interface Db {
  collection(name: string): {
    countDocuments(f?: object): Promise<number>;
    find(f: object, o?: object): { toArray(): Promise<any[]> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    aggregate(p: object[]): { toArray(): Promise<any[]> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  listCollections(): { toArray(): Promise<{ name: string }[]> };
}
interface Report {
  counts: Record<string, Record<string, number>>;
  checks: { name: string; ok: boolean; detail: string }[];
}

/**
 * The checks. Self-contained (no imports / outer references) because docker mode ships its source into the
 * orders container and runs it there with that image's mongodb driver.
 */
async function verify(db: (name: string) => Db, prefix: string): Promise<Report> {
  const S = ['identity', 'marketplace', 'orders', 'payments', 'delivery', 'notifications'];
  const counts: Record<string, Record<string, number>> = {};
  for (const s of S) {
    const d = db(prefix + s);
    counts[s] = {};
    const names = (await d.listCollections().toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();
    for (const n of names) counts[s]![n] = await d.collection(n).countDocuments({});
  }
  const mk = db(prefix + 'marketplace');
  const od = db(prefix + 'orders');
  const pay = db(prefix + 'payments');
  const dl = db(prefix + 'delivery');
  const checks: Report['checks'] = [];
  const add = (name: string, bad: string[], total: number) =>
    checks.push({ name, ok: bad.length === 0, detail: bad.length ? `${bad.length}/${total} failing, e.g. ${bad.slice(0, 3).join('; ')}` : `${total} ok` });
  const sid = (x: unknown) => String(x);

  const children = await od.collection('child_orders').find({}, { projection: { code: 1, status: 1, restaurantId: 1, userId: 1, checkoutGroupId: 1, breakdown: 1, refundedPaise: 1, refundStatus: 1 } }).toArray();
  const childById = new Map(children.map((c) => [sid(c._id), c]));
  const ratings = await mk.collection('ratings').find({}, { projection: { childOrderId: 1, restaurantId: 1, userId: 1, stars: 1 } }).toArray();
  add(
    'ratings belong to delivered children (same restaurant + customer)',
    ratings.filter((r) => { const c = childById.get(sid(r.childOrderId)); return !c || c.status !== 'DELIVERED' || sid(c.restaurantId) !== sid(r.restaurantId) || sid(c.userId) !== sid(r.userId); }).map((r) => `rating ${sid(r._id)} child ${sid(r.childOrderId)}`),
    ratings.length,
  );
  const agg = new Map<string, { sum: number; count: number }>();
  for (const r of ratings) {
    const a = agg.get(sid(r.restaurantId)) ?? { sum: 0, count: 0 };
    a.sum += r.stars;
    a.count++;
    agg.set(sid(r.restaurantId), a);
  }
  const restaurants = await mk.collection('restaurants').find({}, { projection: { slug: 1, name: 1, ratingSum: 1, ratingCount: 1, status: 1 } }).toArray();
  const DEMO = new Set(['spice-route', 'green-leaf', 'tandoor-tales', 'coastal-curry']);
  const checked = restaurants.filter((r) => !DEMO.has(r.slug));
  add(
    'restaurant ratingSum/ratingCount = its ratings',
    checked.filter((r) => { const a = agg.get(sid(r._id)) ?? { sum: 0, count: 0 }; return (r.ratingSum ?? 0) !== a.sum || (r.ratingCount ?? 0) !== a.count; }).map((r) => { const a = agg.get(sid(r._id)) ?? { sum: 0, count: 0 }; return `${r.slug} stored ${r.ratingSum}/${r.ratingCount} actual ${a.sum}/${a.count}`; }),
    checked.length,
  );
  const approved = checked.filter((r) => r.status === 'APPROVED');
  const under5 = approved.filter((r) => (r.ratingCount ?? 0) < 5).length;
  checks.push({ name: 'share of approved restaurants under 5 ratings ("New")', ok: true, detail: `${under5}/${approved.length} (${Math.round((under5 / Math.max(1, approved.length)) * 100)}%)` });

  const coupons = await mk.collection('coupons').find({}, { projection: { code: 1, usedCount: 1 } }).toArray();
  const redeemed = new Map((await mk.collection('coupon_redemptions').aggregate([{ $match: { status: 'REDEEMED' } }, { $group: { _id: '$couponId', n: { $sum: 1 } } }]).toArray()).map((x) => [sid(x._id), x.n as number]));
  add('coupon usedCount = REDEEMED redemptions', coupons.filter((c) => (c.usedCount ?? 0) !== (redeemed.get(sid(c._id)) ?? 0)).map((c) => `${c.code} usedCount ${c.usedCount} redeemed ${redeemed.get(sid(c._id)) ?? 0}`), coupons.length);

  const balances = await pay.collection('ledger_entries').aggregate([{ $group: { _id: { t: '$accountType', a: '$accountId' }, b: { $sum: '$amountPaise' } } }]).toArray();
  add('ledger balances ≥ 0', balances.filter((x) => x.b < 0).map((x) => `${x._id.t}:${x._id.a} ${x.b}`), balances.length);

  const jobs = await dl.collection('delivery_jobs').find({}, { projection: { childOrderId: 1, status: 1, partnerId: 1 } }).toArray();
  const jobByChild = new Map(jobs.map((j) => [sid(j.childOrderId), j]));
  const intents = await pay.collection('payment_intents').find({ purpose: 'CHECKOUT' }, { projection: { referenceId: 1, status: 1, capturedPaise: 1, amountPaise: 1, refundedPaise: 1 } }).toArray();
  const intentByCheckout = new Map(intents.map((i) => [sid(i.referenceId), i]));
  const earnings = new Set((await pay.collection('ledger_entries').find({ entryType: 'ORDER_EARNING' }, { projection: { childOrderId: 1 } }).toArray()).map((e) => sid(e.childOrderId)));
  const delivered = children.filter((c) => c.status === 'DELIVERED');
  const CAPTURED = new Set(['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED']);
  add('delivered child → DELIVERED job', delivered.filter((c) => jobByChild.get(sid(c._id))?.status !== 'DELIVERED').map((c) => `${c.code} job ${jobByChild.get(sid(c._id))?.status ?? 'missing'}`), delivered.length);
  add('delivered child → captured payment', delivered.filter((c) => { const i = intentByCheckout.get(sid(c.checkoutGroupId)); return !i || !CAPTURED.has(i.status) || i.capturedPaise !== i.amountPaise; }).map((c) => `${c.code} intent ${intentByCheckout.get(sid(c.checkoutGroupId))?.status ?? 'missing'}`), delivered.length);
  add('delivered child → ORDER_EARNING ledger entry', delivered.filter((c) => !earnings.has(sid(c._id))).map((c) => c.code), delivered.length);

  const refunds = await pay.collection('refunds').find({ status: 'SUCCEEDED' }, { projection: { childOrderId: 1, amountPaise: 1 } }).toArray();
  const refundedByChild = new Map<string, number>();
  for (const r of refunds) if (r.childOrderId) refundedByChild.set(sid(r.childOrderId), (refundedByChild.get(sid(r.childOrderId)) ?? 0) + r.amountPaise);
  const closed = children.filter((c) => c.status === 'REJECTED' || c.status === 'CANCELLED');
  add(
    'rejected/cancelled child → SUCCEEDED refunds = refundedPaise',
    closed.filter((c) => c.refundStatus === 'SUCCEEDED' && (refundedByChild.get(sid(c._id)) ?? 0) !== c.refundedPaise).map((c) => `${c.code} refunded ${c.refundedPaise} payments ${refundedByChild.get(sid(c._id)) ?? 0}`),
    closed.length,
  );
  const pendingRefunds = closed.filter((c) => c.refundStatus !== 'SUCCEEDED').length;
  if (pendingRefunds) checks.push({ name: 'rejected/cancelled children with a refund still in flight', ok: true, detail: String(pendingRefunds) });

  const groups = await od.collection('checkout_groups').find({ status: { $in: ['COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED', 'IN_PROGRESS', 'PAID_PLACED'] } }, { projection: { code: 1, pricing: 1, childOrderIds: 1 } }).toArray();
  add(
    'checkout total = Σ child totals',
    groups.filter((g) => (g.childOrderIds ?? []).reduce((s: number, id: unknown) => s + (childById.get(sid(id))?.breakdown?.totalPaise ?? 0), 0) !== g.pricing?.totalPaise).map((g) => g.code),
    groups.length,
  );
  const memberships = await mk.collection('memberships').find({}, { projection: { freeDeliveriesUsed: 1, usage: 1 } }).toArray();
  add(
    'membership freeDeliveriesUsed = Σ USED usage',
    memberships.filter((m) => (m.usage ?? []).filter((u: { status: string }) => u.status === 'USED').reduce((s: number, u: { freeDeliveries: number }) => s + u.freeDeliveries, 0) !== (m.freeDeliveriesUsed ?? 0)).map((m) => sid(m._id)),
    memberships.length,
  );
  const partnerIds = new Set((await dl.collection('partners').find({}, { projection: { _id: 1 } }).toArray()).map((p) => sid(p._id)));
  const assigned = jobs.filter((j) => j.partnerId);
  add('delivery jobs reference existing partners', assigned.filter((j) => !partnerIds.has(sid(j.partnerId))).map((j) => sid(j._id)), assigned.length);
  const byLocality = new Map<string, typeof restaurants>();
  const realism = await mk.collection('restaurants').find({ status: 'APPROVED' }, { projection: { slug: 1, name: 1, ownerUserId: 1, 'address.locality': 1, 'images.cover': 1 } }).toArray();
  for (const r of realism) {
    const loc = r.address?.locality ?? '';
    byLocality.set(loc, [...(byLocality.get(loc) ?? []), r]);
  }
  const twice = <T,>(xs: T[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
  add(
    'realism: no cover photo twice within a locality',
    [...byLocality].flatMap(([loc, rs]) => twice(rs.map((r) => r.images?.cover).filter(Boolean)).map((c) => `${loc}: ${c}`)),
    byLocality.size,
  );
  add(
    'realism: no two branches of one brand in a locality',
    [...byLocality].flatMap(([loc, rs]) => twice(rs.map((r) => `${r.ownerUserId}|${r.name}`)).map((k) => `${loc}: ${k.split('|')[1]}`)),
    byLocality.size,
  );
  const projections = new Set((await od.collection('restaurant_projection').find({}, { projection: { _id: 1 } }).toArray()).map((p) => sid(p._id)));
  add('every restaurant has an orders projection', restaurants.filter((r) => !projections.has(sid(r._id))).map((r) => r.slug), restaurants.length);
  return { counts, checks };
}

// ------------------------------------------------------------------------------------- live discover --
class DiscoveryHttpError extends Error {
  constructor(readonly status: number) {
    super(`discovery ${status}`);
  }
}

/** Indiranagar / Koramangala / HSR: the first two Discover pages (gateway) repeat no cover and no restaurant name. */
async function discoverRealism(base: string): Promise<Report['checks']> {
  const SPOTS: [string, number, number][] = [
    ['Indiranagar', 12.9719, 77.6412],
    ['Koramangala', 12.9352, 77.6245],
    ['HSR Layout', 12.9116, 77.6389],
  ];
  const coverBad: string[] = [];
  const nameBad: string[] = [];
  try {
    for (const [name, lat, lng] of SPOTS) {
      const items: { name: string; imageUrl: string | null }[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 2; page++) {
        const q = new URLSearchParams({ lat: String(lat), lng: String(lng), ...(cursor ? { cursor } : {}) });
        const res = await fetch(`${base}/api/v1/discovery/restaurants?${q}`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new DiscoveryHttpError(res.status);
        const body = (await res.json()) as { items: { name: string; imageUrl: string | null }[]; nextCursor: string | null };
        items.push(...body.items);
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      const twice = (xs: string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
      for (const c of twice(items.map((i) => i.imageUrl ?? '').filter(Boolean))) coverBad.push(`${name}: ${c.split('/').slice(-2).join('/')}`);
      for (const n of twice(items.map((i) => i.name))) nameBad.push(`${name}: ${n}`);
    }
  } catch (e) {
    // Only an unreachable gateway is a skip; a reachable gateway answering 429/5xx is a failure.
    if (e instanceof DiscoveryHttpError) return [{ name: 'realism: live Discover pages', ok: false, detail: `discovery answered ${e.status}` }];
    return [{ name: 'realism: live Discover pages', ok: true, detail: `skipped (${base} unreachable: ${(e as Error).message})` }];
  }
  const row = (n: string, bad: string[]) => ({ name: n, ok: bad.length === 0, detail: bad.length ? `${bad.length} repeats, e.g. ${bad.slice(0, 3).join('; ')}` : `${SPOTS.length} localities ok` });
  return [row('realism: live Discover first 2 pages repeat no cover', coverBad), row('realism: live Discover first 2 pages repeat no restaurant (brand twins)', nameBad)];
}

// ------------------------------------------------------------------------------------------- cli --
function print(r: Report): boolean {
  process.stdout.write('=== collection counts\n');
  for (const [svc, cols] of Object.entries(r.counts)) {
    process.stdout.write(`  ${svc}\n`);
    for (const [c, n] of Object.entries(cols)) process.stdout.write(`    ${c.padEnd(28)} ${String(n).padStart(7)}\n`);
  }
  process.stdout.write('\n=== consistency checks\n');
  for (const c of r.checks) process.stdout.write(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}\n`);
  const failed = r.checks.filter((c) => !c.ok).length;
  process.stdout.write(`\nseed-verify: ${r.checks.length - failed}/${r.checks.length} checks passed\n`);
  return failed === 0;
}

async function main() {
  const args = process.argv.slice(2);
  const ui = args.indexOf('--uri');
  const pi = args.indexOf('--db-prefix');
  const prefix = pi >= 0 ? args[pi + 1]! : 'thali_';
  if (ui >= 0) {
    const { default: mongoose } = await import('mongoose');
    const client = await new mongoose.mongo.MongoClient(args[ui + 1]!).connect();
    try {
      const report = await verify((n) => client.db(n) as unknown as Db, prefix);
      report.checks.push(...(await discoverRealism(apiBase())));
      const ok = print(report);
      process.exit(ok ? 0 : 1);
    } finally {
      await client.close();
    }
  }
  // docker stack: run the same function inside the orders container (Mongo is not published to the host)
  const env = mergedEnv();
  const user = env.MONGO_ROOT_USERNAME || 'root';
  const pass = env.MONGO_ROOT_PASSWORD;
  if (!pass) throw new Error('MONGO_ROOT_PASSWORD is not set (.env)');
  const uri = `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@mongo:27017/?replicaSet=rs0&authSource=admin`;
  const program = `
const __name = (f) => f;
const { default: mongoose } = await import('mongoose');
const verify = ${verify.toString()};
const client = await new mongoose.mongo.MongoClient(process.env.VERIFY_URI).connect();
try { process.stdout.write(JSON.stringify(await verify((n) => client.db(n), ${JSON.stringify(prefix)}))); } finally { await client.close(); }
`;
  const out = await new Promise<string>((done, fail) => {
    // `-e VERIFY_URI` without a value: docker takes it from this process's environment, so the root
    // password never appears on a command line (process list)
    const child = spawn('docker', ['compose', 'exec', '-T', '-e', 'VERIFY_URI', 'orders', 'node', '--input-type=module', '-'], {
      cwd: ROOT,
      env: { ...process.env, VERIFY_URI: uri },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let buf = '';
    child.stdout.on('data', (b: Buffer) => (buf += b.toString()));
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done(buf) : fail(new Error(`verify in the orders container exited ${code}`))));
    child.stdin.end(program);
  });
  const report = JSON.parse(out) as Report;
  report.checks.push(...(await discoverRealism(apiBase())));
  process.exit(print(report) ? 0 : 1);
}

const apiBase = () => (process.env.SEED_VERIFY_API ?? mergedEnv().SEED_VERIFY_API ?? 'http://localhost:8080').replace(/\/$/, '');

main().catch((e: unknown) => {
  process.stderr.write(`seed-verify: ${(e as Error).message}\n`);
  process.exit(1);
});
