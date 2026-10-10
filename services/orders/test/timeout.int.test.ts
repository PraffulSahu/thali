import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobModules } from '../src/jobs/index.js';
import { runAcceptanceTimeout, timeoutBackoffMs } from '../src/jobs/acceptance-timeout.js';
import { outboxEvents, setup, type Harness } from './helpers.js';
import { child, group, placedCheckout } from './lifecycle-helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('timeout');
}, 120_000);
afterAll(async () => {
  await h.cleanup();
});

describe('acceptance-timeout sweeper (LLD §8 sweeper b)', () => {
  it('PLACED with past acceptBy → REJECTED (RESTAURANT_TIMEOUT) + refund event; idempotent; others untouched', async () => {
    const p = await placedCheckout(h);
    const accepted = await placedCheckout(h);
    await accepted.ownerA.post(`/api/v1/owner/orders/${accepted.a.id}/accept`, { prepMinutes: 20 });
    const past = new Date(Date.now() - 1000);
    await h.ctx.models.ChildOrder.updateMany({ _id: { $in: [p.a.id, accepted.a.id] } }, { $set: { acceptBy: past } });

    const counts = await runAcceptanceTimeout(h.ctx);
    expect(counts.rejected).toBe(1);

    const a = await child(h, p.a.id);
    expect(a!.status).toBe('REJECTED');
    expect(a!.rejectionReason).toBe('RESTAURANT_TIMEOUT');
    expect(a!.refundStatus).toBe('REQUESTED');
    expect(a!.statusHistory.at(-1)).toMatchObject({ from: 'PLACED', to: 'REJECTED', actor: 'SYSTEM', reason: 'RESTAURANT_TIMEOUT' });
    expect((await child(h, p.b.id))!.status).toBe('PLACED');
    expect((await child(h, accepted.a.id))!.status).toBe('ACCEPTED');
    expect((await group(h, p.checkout.id))!.status).toBe('IN_PROGRESS');

    const ev = (await outboxEvents(h, 'order.rejected')).filter((e) => e.payload.childOrderId === p.a.id);
    expect(ev.map((e) => e.payload)).toEqual([
      { childOrderId: p.a.id, checkoutId: p.checkout.id, userId: p.u.userId, restaurantId: p.s.a.id, reason: 'RESTAURANT_TIMEOUT', refundPaise: p.a.total, fromStatus: 'PLACED' },
    ]);

    expect((await runAcceptanceTimeout(h.ctx)).rejected).toBe(0);
    expect((await outboxEvents(h, 'order.rejected')).filter((e) => e.payload.childOrderId === p.a.id)).toHaveLength(1);

    const view = await p.u.get(`/api/v1/orders/${p.checkout.id}`);
    const ex = view.body.explanations.find((e: { childOrderId: string }) => e.childOrderId === p.a.id);
    expect(ex).toMatchObject({ kind: 'REJECTED', reason: 'RESTAURANT_TIMEOUT', refundStatus: 'REQUESTED' });
    expect(ex.message).toMatch(/^Spice Route did not respond in time\. ₹[\d,]+\.\d{2} refund initiated\.$/);
  });

  it('is registered in jobModules with the configured interval (run under the service-kit leader lock)', () => {
    const job = jobModules.find((j) => j.name === 'orders:acceptance-timeout');
    expect(job).toBeDefined();
    expect(job!.intervalMs(h.config)).toBe(h.config.ACCEPT_TIMEOUT_INTERVAL_MS);
  });

  it('children that keep failing are backed off and cannot starve the batch', async () => {
    const poisoned = await placedCheckout(h);
    const healthy = await placedCheckout(h);
    // break the poisoned checkout (parent missing → transition throws) and make it the oldest due
    await h.ctx.models.CheckoutGroup.deleteOne({ _id: poisoned.checkout.id });
    await h.ctx.models.ChildOrder.updateMany({ _id: { $in: [poisoned.a.id, poisoned.b.id] } }, { $set: { acceptBy: new Date(Date.now() - 60_000) } });
    await h.ctx.models.ChildOrder.updateOne({ _id: healthy.a.id }, { $set: { acceptBy: new Date(Date.now() - 1000) } });

    const first = await runAcceptanceTimeout(h.ctx, { batch: 2 });
    expect(first).toMatchObject({ rejected: 0, failed: 2 });
    const pa = await child(h, poisoned.a.id);
    expect(pa!.timeoutFailures).toBe(1);
    expect(new Date(pa!.timeoutRetryAt!).getTime()).toBeGreaterThan(Date.now() + 20_000);

    const second = await runAcceptanceTimeout(h.ctx, { batch: 2 });
    expect(second).toMatchObject({ rejected: 1, failed: 0 });
    expect((await child(h, healthy.a.id))!.status).toBe('REJECTED');
    expect(timeoutBackoffMs(1)).toBe(30_000);
    expect(timeoutBackoffMs(3)).toBe(120_000);
    expect(timeoutBackoffMs(20)).toBe(15 * 60_000);
  });

});
