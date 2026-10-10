/**
 * Flow 8: a partial rejection produces the correct customer experience and refund workflow.
 * Paid checkout with Spice Route + Green Leaf; Spice Route accepts, Green Leaf rejects from its board (reason
 * required). The customer sees the rejected part with the reason and its refund, the accepted part carries on,
 * and the payment summary shows the refund / net paid. API: child states, refund SUCCEEDED for exactly the
 * Green Leaf part, payment PARTIALLY_REFUNDED.
 */
import { expect, test } from '@playwright/test';
import { call, getOrder, login, ok, owner, placeOrder, waitFor, type Json } from '../fixtures/api.js';
import { PHONES, RESTAURANTS, SIMPLE_ITEMS, formatINR } from '../fixtures/env.js';
import { signInViaPage } from '../fixtures/otp.js';
import { childSection, newRoleContext } from '../fixtures/ui.js';

const REASON = 'Item(s) out of stock';

test('partial rejection: customer messaging, updated totals, refund', async ({ browser }) => {
  const consumer = await login('consumer2');
  const order = await placeOrder(consumer.token, [
    { restaurant: SIMPLE_ITEMS.paneerTikka.restaurant, name: SIMPLE_ITEMS.paneerTikka.name },
    { restaurant: SIMPLE_ITEMS.dalMakhani.restaurant, name: SIMPLE_ITEMS.dalMakhani.name },
  ]);
  const spice = order.child(RESTAURANTS.spiceRoute.id);
  const green = order.child(RESTAURANTS.greenLeaf.id);
  const greenTotal: number = green.breakdown.totalPaise;

  const owner1 = await login('owner1');
  await owner.accept(owner1.token, spice.id, 15);

  const o2 = await newRoleContext(browser);
  const c = await newRoleContext(browser);
  try {
    // ---- Green Leaf rejects from its live board
    await signInViaPage(o2.page, PHONES.owner2, '/restaurant/orders');
    await o2.page.getByRole('combobox', { name: 'Restaurant' }).selectOption({ label: RESTAURANTS.greenLeaf.name });
    const card = o2.page.getByRole('listitem', { name: `Order ${green.code}` });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Reject' }).click();
    const dialog = o2.page.getByRole('alertdialog', { name: `Reject order ${green.code}?` });
    await expect(dialog.getByRole('button', { name: 'Reject order' })).toBeDisabled(); // a reason is required
    await dialog.getByLabel('Reason').selectOption({ label: REASON });
    await dialog.getByRole('button', { name: 'Reject order' }).click();
    await expect(o2.page.getByText(`Order ${green.code} rejected`)).toBeVisible();
    await expect(card).toBeHidden(); // leaves the active board

    // ---- API: one part rejected (refund requested -> succeeded), the other unaffected
    const settled = await waitFor('Green Leaf refund SUCCEEDED', async () => {
      const o = await getOrder(consumer.token, order.checkoutId);
      const g = o.checkout.children.find((x: Json) => x.id === green.id);
      return g.status === 'REJECTED' && g.refundStatus === 'SUCCEEDED' ? o : null;
    }, { timeoutMs: 120_000 });
    const g = settled.checkout.children.find((x: Json) => x.id === green.id);
    const s = settled.checkout.children.find((x: Json) => x.id === spice.id);
    expect(g.refundedPaise).toBe(greenTotal);
    expect(g.rejectionReason).toBe(REASON);
    expect(s.status).toBe('ACCEPTED');
    expect(s.refundStatus).toBe('NONE');
    expect(settled.checkout.status).not.toBe('CANCELLED');
    expect(settled.adjustedTotals).toMatchObject({ paidPaise: order.totalPaise, refundedPaise: greenTotal, netPaise: order.totalPaise - greenTotal, refundPendingPaise: 0 });
    const expl = (settled.explanations as Json[]).find((e) => e.childOrderId === green.id);
    expect(expl).toMatchObject({ kind: 'REJECTED', refundPaise: greenTotal });
    const payment = ok(await call('GET', `/payments/checkout/${order.checkoutId}`, { token: consumer.token }), 'GET payment');
    expect(payment.status).toBe('PARTIALLY_REFUNDED');
    expect(payment.refundedPaise).toBe(greenTotal);

    // ---- customer UI: rejected part explained + refunded, accepted part continues, totals updated
    await signInViaPage(c.page, PHONES.consumer2, `/orders/${order.checkoutId}`);
    const gSec = childSection(c.page, RESTAURANTS.greenLeaf.name);
    await expect(gSec.getByText('Rejected by restaurant', { exact: true }).first()).toBeVisible();
    await expect(gSec).toContainText(expl.message);
    await expect(gSec).toContainText(REASON);
    await expect(gSec).toContainText('Refunded');
    await expect(gSec).toContainText(formatINR(greenTotal));
    const sSec = childSection(c.page, RESTAURANTS.spiceRoute.name);
    await expect(sSec.getByText('Accepted', { exact: true }).first()).toBeVisible();
    await expect(sSec).not.toContainText('Refund');
    const summary = c.page.getByRole('region', { name: 'Payment summary' });
    await expect(summary).toContainText(`−${formatINR(greenTotal)}`);
    await expect(summary).toContainText('Net paid');
    await expect(summary).toContainText(formatINR(order.totalPaise - greenTotal));

    // order list reflects the refund too
    await c.page.goto('/orders');
    await expect(c.page.getByRole('listitem').filter({ hasText: `Order ${order.code}` })).toContainText(`${formatINR(greenTotal)} refunded`);
  } finally {
    await o2.context.close();
    await c.context.close();
  }
});
