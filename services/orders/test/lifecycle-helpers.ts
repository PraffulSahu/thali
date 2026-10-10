/**
 * Task 12 test helpers: role-specific agents (owner / admin / partner) and a fully PLACED
 * two-restaurant checkout (A = "Spice Route", B = "Dosa Corner").
 */
import request from 'supertest';
import { Types } from 'mongoose';
import { withTransaction } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import { formatINR, type Role } from '@thali/contracts';
import { applyCapturedPayment } from '../src/domain/place.js';
import { asUser, DROP_ADDRESS, fillTwoRestaurantCart, idemKey, oid, type Harness } from './helpers.js';

export type Agent = Awaited<ReturnType<typeof asRole>>;

export async function asRole(h: Harness, roles: Role[], extraClaims: Record<string, unknown> = {}, userId = oid()) {
  const token = await h.keys.sign({ sub: userId, roles, ...extraClaims });
  const auth = { authorization: `Bearer ${token}` };
  return {
    userId,
    token,
    get: (path: string) => request(h.app).get(path).set(auth),
    post: (path: string, body?: object) => request(h.app).post(path).set(auth).send(body ?? {}),
    put: (path: string, body?: object) => request(h.app).put(path).set(auth).send(body ?? {}),
    patch: (path: string, body?: object) => request(h.app).patch(path).set(auth).send(body ?? {}),
    del: (path: string) => request(h.app).delete(path).set(auth),
  };
}

export const asOwner = (h: Harness, ownerUserId: string) => asRole(h, ['CONSUMER', 'RESTAURANT_OWNER'], {}, ownerUserId);
export const asPartner = (h: Harness) => asRole(h, ['CONSUMER', 'DELIVERY_PARTNER']);
export const asAdmin = (h: Harness, opts: { mfa?: boolean; adm?: string[] } = {}) =>
  asRole(h, ['CONSUMER', 'ADMIN'], { amr: opts.mfa === false ? ['pwd'] : ['pwd', 'mfa'], adm: opts.adm ?? ['SUPER_ADMIN'] });

export const oidOf = (id: string) => new Types.ObjectId(id) as never;

/** Checkout with two children, payment captured → both PLACED. */
export async function placedCheckout(h: Harness) {
  const u = await asUser(h);
  h.identity.addUser(u.userId);
  const s = await fillTwoRestaurantCart(h, u);
  const r = await request(h.app)
    .post('/api/v1/checkouts')
    .set('authorization', `Bearer ${u.token}`)
    .set('Idempotency-Key', idemKey())
    .send({ address: DROP_ADDRESS });
  if (r.status !== 201) throw new Error(`checkout failed ${r.status} ${r.text}`);
  const checkout = r.body.checkout as { id: string; code: string; pricing: { totalPaise: number } };
  const outcome = await withTransaction(h.ctx.conn, (session) =>
    applyCapturedPayment(h.ctx, session, {
      checkoutId: checkout.id,
      paymentIntentId: r.body.payment.intentId,
      amountPaise: checkout.pricing.totalPaise,
      source: 'payment.captured',
    }),
  );
  if (outcome !== 'PLACED') throw new Error(`not placed: ${outcome}`);
  const kids = await h.ctx.models.ChildOrder.find({ checkoutGroupId: checkout.id }).lean();
  const a = kids.find((k) => k.restaurantId === s.a.id)!;
  const b = kids.find((k) => k.restaurantId === s.b.id)!;
  return {
    u,
    s,
    checkout,
    paymentIntentId: r.body.payment.intentId as string,
    a: { id: String(a._id), total: a.breakdown.totalPaise, code: a.code, pickupCode: a.pickupCode, deliveryCode: a.deliveryCode },
    b: { id: String(b._id), total: b.breakdown.totalPaise, code: b.code, pickupCode: b.pickupCode, deliveryCode: b.deliveryCode },
    ownerA: await asOwner(h, s.a.ownerUserId),
    ownerB: await asOwner(h, s.b.ownerUserId),
  };
}
export type Placed = Awaited<ReturnType<typeof placedCheckout>>;

export const child = (h: Harness, id: string) => h.ctx.models.ChildOrder.findById(id).lean();
export const group = (h: Harness, id: string) => h.ctx.models.CheckoutGroup.findById(id).lean();

/** Wait until the consumer has committed the event (inbox row present). */
export const processed = (h: Harness, eventId: string) =>
  waitFor(async () => (await h.db.conn.collection('inbox').findOne({ _id: eventId as never })) !== null, { timeoutMs: 8000 });

/** "₹536.96" style rupee formatting used by customer explanations. */
export const rupees = (paise: number): string => formatINR(paise);
