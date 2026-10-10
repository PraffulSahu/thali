/**
 * System: three partners accept the same delivery at once.
 * Three approved partners are online next to Spice Route with fresh locations, so one dispatch round offers
 * the new job to all three (OFFERS_PER_ROUND=3). They accept concurrently: exactly one is assigned, the others
 * are told it was taken / no longer available, and only the winner holds the job.
 *
 * Only partner1 and partner2 have demo phones, so the third partner is owner2 onboarded as an (approved,
 * bicycle) delivery partner through the real onboarding API + admin approval (idempotent).
 */
import { expect, test } from '@playwright/test';
import { call, getOrder, login, owner, partner, placeOrder, waitFor, type Json, type Session } from '../../fixtures/api.js';
import { GEO, RESTAURANTS, SIMPLE_ITEMS } from '../../fixtures/env.js';
import { adminCancelChild, ensureApprovedPartner, partnerOnline, pingLocation, resetPartner } from '../../fixtures/system.js';

test.setTimeout(420_000);

const BASE = { lat: GEO.nearSpiceRoute.latitude, lng: GEO.nearSpiceRoute.longitude };

test('3 partners accept the same job concurrently: exactly one is assigned', async () => {
  const consumer = await login('consumer1');
  const owner1 = await login('owner1');
  const partners: Session[] = [await login('partner1'), await login('partner2'), await login('owner2')];
  await ensureApprovedPartner(partners[2]!.token, 'Sunita Menon');
  const spots = partners.map((_, i) => ({ lat: BASE.lat + i * 0.0003, lng: BASE.lng }));

  let childId: string | null = null;
  let childTotal = 0;
  try {
    for (const [i, p] of partners.entries()) {
      await resetPartner(p.token);
      await partnerOnline(p.token, spots[i]!);
    }

    const order = await placeOrder(consumer.token, [{ restaurant: SIMPLE_ITEMS.paneerTikka.restaurant, name: SIMPLE_ITEMS.paneerTikka.name }]);
    const child = order.child(RESTAURANTS.spiceRoute.id);
    childId = child.id;
    childTotal = child.breakdown.totalPaise;
    await owner.accept(owner1.token, child.id, 10); // creates the delivery job -> dispatch

    // every partner holds a live offer for this job (decline offers for other jobs, keep locations fresh)
    const offers = await waitFor('an offer for the job on all 3 partners', async () => {
      const found: (Json | undefined)[] = [];
      for (const [i, p] of partners.entries()) {
        const list = await partner.offers(p.token);
        for (const o of list) if (o.status === 'OFFERED' && o.job?.childOrderId !== child.id) await partner.rejectOffer(p.token, o.id);
        const mine = list.find((o: Json) => o.status === 'OFFERED' && o.job?.childOrderId === child.id);
        if (!mine) await pingLocation(p.token, spots[i]!);
        found.push(mine);
      }
      return found.every(Boolean) ? (found as Json[]) : null;
    }, { timeoutMs: 180_000, intervalMs: 3100 });
    expect(new Set(offers.map((o) => o.jobId)).size).toBe(1);

    // ---- the race
    const results = await Promise.all(partners.map((p, i) => call('POST', `/deliveries/offers/${offers[i]!.id}/accept`, { token: p.token })));
    const summary = results.map((r) => `${r.status} ${r.body?.error?.code ?? r.body?.job?.status}`).join(', ');
    const winners = results.map((r, i) => ({ r, i })).filter(({ r }) => r.status === 200);
    expect(winners.length, summary).toBe(1);
    for (const { r } of results.map((r, i) => ({ r, i })).filter(({ r }) => r.status !== 200)) {
      expect(r.status, summary).toBe(409);
      expect(r.body.error.code, summary).toMatch(/ASSIGNMENT_TAKEN|OFFER_EXPIRED/);
    }
    const w = winners[0]!.i;
    expect(winners[0]!.r.body.job.status).toBe('ASSIGNED');

    // only the winner holds the job; the losers' offers are no longer live
    for (const [i, p] of partners.entries()) {
      const active = (await partner.active(p.token)).filter((j: Json) => j.childOrderId === child.id);
      expect(active, `partner #${i} active jobs`).toHaveLength(i === w ? 1 : 0);
      if (i !== w) {
        const live = (await partner.offers(p.token)).filter((o: Json) => o.status === 'OFFERED' && o.job?.childOrderId === child.id);
        expect(live).toHaveLength(0);
      }
    }
    await waitFor('customer sees the partner assigned', async () => {
      const c = (await getOrder(consumer.token, order.checkoutId)).checkout.children[0];
      return c.deliveryStatus === 'ASSIGNED' ? c : null;
    });
  } finally {
    // cleanup: cancel the test order (cancels its delivery job) and take everyone offline
    if (childId) await adminCancelChild(childId, childTotal, 'e2e cleanup: assignment race').catch(() => undefined);
    for (const p of partners) await call('POST', '/partner/offline', { token: p.token }).catch(() => undefined);
  }
});
