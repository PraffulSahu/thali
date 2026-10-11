/**
 * Payments slice of the Bengaluru dataset (`@thali/contracts/seed-blr`), bulk + idempotent. Same amounts and
 * ids as the orders / delivery / marketplace slices:
 *  - a captured mock payment intent (+ the mock gateway's payment record) per historical checkout, status
 *    CAPTURED / PARTIALLY_REFUNDED / REFUNDED; one per Thali Plus membership term (purpose MEMBERSHIP)
 *  - a SUCCEEDED refund (+ mock refund) for every rejected / cancelled child order
 *  - the four ledger postings of `recordDeliveryEarnings` per delivered child (live dedupe keys
 *    `earning:` / `commission:` / `platform-commission:<childId>`, `delivery:<jobId>`)
 *  - weekly PAID manual payouts with a bank UTR (+ PAYOUT ledger entry `payout:<payoutId>`) for every
 *    restaurant and partner, each settling exactly that week's net earnings (balances never negative)
 */
import type { Connection, Model } from 'mongoose';
import { seedId } from '@thali/contracts/seed';
import { BLR_PLAN, blrDeliveryLedger, blrWeeklyPayouts, type BlrCheckout, type BlrWorld } from '@thali/contracts/seed-blr';
import { ensureDocsBulk, type SeedReport } from '@thali/service-kit/seed';
import { createModels } from './context.js';
import { createMockProvider } from './providers/mock-provider.js';
import type { PaymentsSeedConfig } from './seed.js';

const ADMIN = seedId('user:admin');
/** Calendar date in Asia/Kolkata (period bounds are IST midnights, i.e. 18:30Z of the previous UTC day). */
const istDate = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

function intentDoc(co: BlrCheckout) {
  const t0 = co.placedAt;
  const created = new Date(co.createdAt.getTime() + 8_000);
  const intentId = seedId(`blr:payment-intent:${co.n}`);
  const history: Record<string, unknown>[] = [
    { from: null, to: 'CREATED', at: created, source: 'create' },
    { from: 'CREATED', to: 'AUTHORIZED', at: new Date(t0.getTime() - 400), source: `webhook:evt_mock_blr_${co.n}_auth` },
    { from: 'AUTHORIZED', to: 'CAPTURED', at: t0, source: `webhook:evt_mock_blr_${co.n}_capture` },
  ];
  let changedAt = t0;
  let refundedSoFar = 0;
  for (const ch of [...co.children].filter((c) => c.refundPaise > 0).sort((a, b) => a.timeline.refundSucceededAt!.getTime() - b.timeline.refundSucceededAt!.getTime())) {
    const from = refundedSoFar === 0 ? 'CAPTURED' : 'PARTIALLY_REFUNDED';
    refundedSoFar += ch.refundPaise;
    const to = refundedSoFar === co.totals.totalPaise ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    if (from !== to) history.push({ from, to, at: ch.timeline.refundSucceededAt, source: `refund:${seedId(`blr:refund:${co.n}:${ch.c}`)}` });
    changedAt = ch.timeline.refundSucceededAt!;
  }
  return {
    _id: intentId,
    purpose: 'CHECKOUT',
    referenceId: co.id,
    userId: co.consumer.id,
    amountPaise: co.totals.totalPaise,
    currency: 'INR',
    provider: 'mock',
    providerOrderId: `mock_order_blr_${co.n}`,
    providerPaymentId: `pay_mock_blr_${co.n}`,
    status: co.paymentStatus,
    capturedPaise: co.totals.totalPaise,
    refundedPaise: co.refundedPaise,
    refundReservedPaise: co.refundedPaise,
    statusHistory: history,
    statusChangedAt: changedAt,
    isDemo: true,
    orderCreateAttempts: 1,
    createdAt: created,
    updatedAt: changedAt,
  };
}

export async function seedPaymentsBlr(conn: Connection, w: BlrWorld, cfg: PaymentsSeedConfig): Promise<SeedReport> {
  const m = createModels(conn);
  createMockProvider({ conn, webhookSecret: 'seed-only-not-used-for-signing' });
  const MockPayment = conn.models.MockProviderPayment as Model<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const MockRefund = conn.models.MockProviderRefund as Model<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const report: SeedReport = {};
  const sfx = ' (blr)';
  const partnerPay = { basePaise: cfg.PARTNER_BASE_PAYOUT_PAISE, perKmPaise: cfg.PARTNER_PER_KM_PAISE };

  await ensureDocsBulk(m.PaymentIntent, (function* () {
    for (const co of w.checkouts) yield intentDoc(co);
    for (const ms of w.memberships) {
      const at = new Date(ms.startsAt.getTime() - 30_000);
      yield {
        _id: ms.paymentIntentId,
        purpose: 'MEMBERSHIP',
        referenceId: ms.id,
        userId: ms.userId,
        amountPaise: BLR_PLAN.pricePaise,
        currency: 'INR',
        provider: 'mock',
        providerOrderId: ms.providerOrderId,
        providerPaymentId: ms.providerPaymentId,
        status: 'CAPTURED',
        capturedPaise: BLR_PLAN.pricePaise,
        refundedPaise: 0,
        refundReservedPaise: 0,
        statusHistory: [
          { from: null, to: 'CREATED', at: new Date(at.getTime() - 40_000), source: 'create' },
          { from: 'CREATED', to: 'AUTHORIZED', at: new Date(ms.startsAt.getTime() - 400), source: `webhook:evt_mock_blr_m${ms.j}_${ms.term}_auth` },
          { from: 'AUTHORIZED', to: 'CAPTURED', at: ms.startsAt, source: `webhook:evt_mock_blr_m${ms.j}_${ms.term}_capture` },
        ],
        statusChangedAt: ms.startsAt,
        isDemo: true,
        orderCreateAttempts: 1,
        createdAt: new Date(at.getTime() - 40_000),
        updatedAt: ms.startsAt,
      };
    }
  })(), report, { label: `payment_intents${sfx}` });

  await ensureDocsBulk(MockPayment, (function* () {
    for (const co of w.checkouts) yield { _id: `pay_mock_blr_${co.n}`, orderId: `mock_order_blr_${co.n}`, amountPaise: co.totals.totalPaise, currency: 'INR', status: 'captured', createdAt: co.placedAt };
    for (const ms of w.memberships) yield { _id: ms.providerPaymentId, orderId: ms.providerOrderId, amountPaise: BLR_PLAN.pricePaise, currency: 'INR', status: 'captured', createdAt: ms.startsAt };
  })(), report, { label: `mock_provider_payments${sfx}` });

  const refunds = () =>
    (function* () {
      for (const co of w.checkouts) for (const ch of co.children) if (ch.refundPaise > 0) yield { co, ch };
    })();
  await ensureDocsBulk(m.Refund, (function* () {
    for (const { co, ch } of refunds()) {
      const t = ch.timeline;
      const rejected = ch.outcome.kind === 'REJECTED';
      const reason = rejected ? 'RESTAURANT_REJECTED' : 'CUSTOMER_CANCELLED';
      const processing = new Date(t.refundSucceededAt!.getTime() - 2_000);
      const source = `event:order.${rejected ? 'rejected' : 'cancelled'}`;
      yield {
        _id: seedId(`blr:refund:${co.n}:${ch.c}`),
        paymentIntentId: seedId(`blr:payment-intent:${co.n}`),
        checkoutGroupId: co.id,
        childOrderId: ch.id,
        restaurantId: null,
        amountPaise: ch.refundPaise,
        reason,
        idempotencyKey: `refund:${ch.id}:${reason}`,
        status: 'SUCCEEDED',
        providerRefundId: `mock_rfnd_blr_${co.n}_${ch.c}`,
        providerKeySeq: 0,
        attempts: 1,
        maxAttempts: 5,
        processingSince: processing,
        requestedBy: source,
        chargeRestaurantPaise: 0,
        reserved: true,
        isDemo: true,
        statusHistory: [
          { from: null, to: 'REQUESTED', at: t.refundRequestedAt, source },
          { from: 'REQUESTED', to: 'PROCESSING', at: processing, source: 'worker' },
          { from: 'PROCESSING', to: 'SUCCEEDED', at: t.refundSucceededAt, source: 'provider:create' },
        ],
        createdAt: t.refundRequestedAt,
        updatedAt: t.refundSucceededAt,
      };
    }
  })(), report, { label: `refunds${sfx}` });
  await ensureDocsBulk(MockRefund, (function* () {
    for (const { co, ch } of refunds()) {
      const refundId = seedId(`blr:refund:${co.n}:${ch.c}`);
      const reason = ch.outcome.kind === 'REJECTED' ? 'RESTAURANT_REJECTED' : 'CUSTOMER_CANCELLED';
      yield {
        _id: `mock_rfnd_blr_${co.n}_${ch.c}`,
        paymentId: `pay_mock_blr_${co.n}`,
        amountPaise: ch.refundPaise,
        status: 'processed',
        notes: { childOrderId: ch.id, reason, isDemo: 'true' },
        idempotencyKey: `thali_${refundId}_0`,
      };
    }
  })(), report, { label: `mock_provider_refunds${sfx}` });

  await ensureDocsBulk(m.LedgerEntry, (function* () {
    for (const e of blrDeliveryLedger(w, partnerPay)) {
      yield {
        _id: seedId(`blr:ledger:${e.kind}:${e.key}`),
        accountType: e.accountType,
        accountId: e.accountId,
        entryType: e.entryType,
        amountPaise: e.amountPaise,
        childOrderId: e.childOrderId,
        deliveryJobId: e.deliveryJobId,
        dedupeKey: e.dedupeKey,
        memo: e.memo,
        createdBy: e.createdBy,
        isDemo: true,
        createdAt: e.at,
        updatedAt: e.at,
      };
    }
  })(), report, { label: `ledger_entries${sfx}`, chunk: 2000 });

  const payouts = blrWeeklyPayouts(w, partnerPay);
  await ensureDocsBulk(
    m.Payout,
    payouts.map((p) => ({
      _id: p.id,
      accountType: p.accountType,
      accountId: p.accountId,
      amountPaise: p.amountPaise,
      status: 'PAID',
      method: 'MANUAL_BANK_TRANSFER',
      utr: p.utr,
      requestedBy: ADMIN,
      confirmedBy: ADMIN,
      confirmedAt: p.paidAt,
      notes: `Weekly settlement ${istDate(p.periodFrom)} – ${istDate(new Date(p.periodTo.getTime() - 1))}`,
      isDemo: true,
      statusHistory: [
        { from: null, to: 'REQUESTED', at: p.requestedAt, source: `admin:${ADMIN}` },
        { from: 'REQUESTED', to: 'PAID', at: p.paidAt, source: `admin:${ADMIN}` },
      ],
      createdAt: p.requestedAt,
      updatedAt: p.paidAt,
    })),
    report,
    { label: `payouts${sfx}` },
  );
  await ensureDocsBulk(
    m.LedgerEntry,
    payouts.map((p) => ({
      _id: seedId(`blr:ledger:payout:${p.id}`),
      accountType: p.accountType,
      accountId: p.accountId,
      entryType: 'PAYOUT',
      amountPaise: -p.amountPaise,
      dedupeKey: `payout:${p.id}`,
      memo: `Manual bank transfer UTR ${p.utr}`,
      createdBy: ADMIN,
      payoutId: p.id,
      isDemo: true,
      createdAt: p.paidAt,
      updatedAt: p.paidAt,
    })),
    report,
    { label: `ledger_entries (blr payouts)` },
  );
  return report;
}
