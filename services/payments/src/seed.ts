/**
 * Payments demo seed (APP_MODE=demo only; idempotent; writes only thali_payments).
 *
 *   container:  docker compose exec payments node dist/seed.js
 *   local:      npm run seed -w @thali/payments
 *
 * Money records matching the orders seed (`@thali/contracts/seed-demo`, same amounts and ids):
 *  - one mock payment intent per demo checkout + the mock gateway's payment record:
 *      TH-DEMOMULTI PARTIALLY_REFUNDED, TH-DEMODONE CAPTURED, TH-DEMOCNCL REFUNDED
 *  - refunds SUCCEEDED for TH-DEMOMULTI child B (RESTAURANT_REJECTED) and TH-DEMOCNCL (CUSTOMER_CANCELLED)
 *  - ledger for each delivered child exactly as `recordDeliveryEarnings` posts it: restaurant ORDER_EARNING
 *    (items + packaging), restaurant COMMISSION (−bps of items), platform COMMISSION (+), partner DELIVERY_EARNING
 *    (base + ceil(km) × per-km)
 *  - a recorded (PAID) manual payout to Spice Route with its PAYOUT ledger entry.
 */
import type { Connection } from 'mongoose';
import { bpsOf } from '@thali/contracts';
import { seedId } from '@thali/contracts/seed';
import { DEMO_CHECKOUTS, DEMO_PARTNER_PAYOUT, demoOrderIds as ids, demoRefundPaise, demoTimeline, type DemoCheckout, type DemoChild } from '@thali/contracts/seed-demo';
import { ensureDocs, isMainModule, runSeedCli, type SeedReport } from '@thali/service-kit/seed';
import { createModels, initPayments, type PaymentsContext } from './context.js';
import { deliveryEarningPaise } from './domain/ledger.js';
import { createMockProvider } from './providers/mock-provider.js';

export interface PaymentsSeedConfig {
  PARTNER_BASE_PAYOUT_PAISE: number;
  PARTNER_PER_KM_PAISE: number;
}

const PAYOUT = { key: 'spice-route-1', amountPaise: 20000, utr: 'DEMOUTR00000001', at: new Date('2026-10-09T05:30:00.000Z') };

function intentDocs(co: DemoCheckout) {
  const t0 = new Date(co.placedAt);
  const created = new Date(t0.getTime() - 50_000);
  const refunds = co.children.map((c) => ({ c, amount: demoRefundPaise(c) })).filter((x) => x.amount > 0);
  const refunded = refunds.reduce((s, r) => s + r.amount, 0);
  const history: Record<string, unknown>[] = [
    { from: null, to: 'CREATED', at: created, source: 'create' },
    { from: 'CREATED', to: 'AUTHORIZED', at: new Date(t0.getTime() - 400), source: `webhook:evt_mock_demo_${co.key}_auth` },
    { from: 'AUTHORIZED', to: 'CAPTURED', at: t0, source: `webhook:evt_mock_demo_${co.key}_capture` },
  ];
  let changedAt = t0;
  if (refunded) {
    const r = refunds[0]!;
    const at = demoTimeline(co, r.c).refundSucceededAt!;
    history.push({ from: 'CAPTURED', to: refunded === co.totals.totalPaise ? 'REFUNDED' : 'PARTIALLY_REFUNDED', at, source: `refund:${ids.refund(co, r.c)}` });
    changedAt = at;
  }
  return {
    intent: {
      _id: ids.intent(co),
      purpose: 'CHECKOUT',
      referenceId: ids.checkout(co),
      userId: ids.user(co.consumer),
      amountPaise: co.totals.totalPaise,
      currency: 'INR',
      provider: 'mock',
      providerOrderId: ids.providerOrderId(co),
      providerPaymentId: ids.providerPaymentId(co),
      status: co.paymentStatus,
      capturedPaise: co.totals.totalPaise,
      refundedPaise: refunded,
      refundReservedPaise: refunded,
      statusHistory: history,
      statusChangedAt: changedAt,
      isDemo: true,
      orderCreateAttempts: 1,
      createdAt: created,
      updatedAt: changedAt,
    },
    mockPayment: {
      _id: ids.providerPaymentId(co),
      orderId: ids.providerOrderId(co),
      amountPaise: co.totals.totalPaise,
      currency: 'INR',
      status: 'captured',
      createdAt: t0,
    },
  };
}

function refundDocs(co: DemoCheckout, c: DemoChild) {
  const amount = demoRefundPaise(c);
  const t = demoTimeline(co, c) as Required<Pick<ReturnType<typeof demoTimeline>, 'refundRequestedAt' | 'refundSucceededAt'>>;
  const reason = c.outcome.kind === 'REJECTED' ? 'RESTAURANT_REJECTED' : 'CUSTOMER_CANCELLED';
  const idempotencyKey = `refund:${ids.child(co, c)}:${reason}`;
  const processing = new Date(t.refundSucceededAt.getTime() - 2_000);
  return {
    refund: {
      _id: ids.refund(co, c),
      paymentIntentId: ids.intent(co),
      checkoutGroupId: ids.checkout(co),
      childOrderId: ids.child(co, c),
      restaurantId: null,
      amountPaise: amount,
      reason,
      idempotencyKey,
      status: 'SUCCEEDED',
      providerRefundId: ids.providerRefundId(co, c),
      providerKeySeq: 0,
      attempts: 1,
      maxAttempts: 5,
      processingSince: processing,
      requestedBy: c.outcome.kind === 'REJECTED' ? 'event:order.rejected' : 'event:order.cancelled',
      chargeRestaurantPaise: 0,
      reserved: true,
      isDemo: true,
      statusHistory: [
        { from: null, to: 'REQUESTED', at: t.refundRequestedAt, source: `event:order.${c.outcome.kind === 'REJECTED' ? 'rejected' : 'cancelled'}` },
        { from: 'REQUESTED', to: 'PROCESSING', at: processing, source: 'worker' },
        { from: 'PROCESSING', to: 'SUCCEEDED', at: t.refundSucceededAt, source: 'provider:create' },
      ],
      createdAt: t.refundRequestedAt,
      updatedAt: t.refundSucceededAt,
    },
    mockRefund: {
      _id: ids.providerRefundId(co, c),
      paymentId: ids.providerPaymentId(co),
      amountPaise: amount,
      status: 'processed',
      notes: { childOrderId: ids.child(co, c), reason, isDemo: 'true' },
      idempotencyKey: `thali_${ids.refund(co, c)}_0`, // providerIdempotencyKey(refund) with providerKeySeq 0
    },
  };
}

/** The four postings `recordDeliveryEarnings` makes for a delivered child (same dedupe keys and memos). */
function ledgerDocs(co: DemoCheckout, c: DemoChild, cfg: PaymentsSeedConfig) {
  if (c.outcome.kind !== 'DELIVERED') return [];
  const at = demoTimeline(co, c).deliveredAt!;
  const childOrderId = ids.child(co, c);
  const restaurantId = ids.restaurant(c.restaurant);
  const b = c.breakdown;
  const commission = bpsOf(b.itemsSubtotalPaise, c.restaurant.commissionBps);
  const jobId = ids.job(co, c);
  const base = { childOrderId, createdBy: 'system:order.delivered', isDemo: true, createdAt: at, updatedAt: at };
  return [
    { _id: seedId(`ledger:earning:${co.key}:${c.key}`), ...base, accountType: 'RESTAURANT', accountId: restaurantId, entryType: 'ORDER_EARNING', amountPaise: b.itemsSubtotalPaise + b.packagingFeePaise, dedupeKey: `earning:${childOrderId}`, memo: `Order earning (items ${b.itemsSubtotalPaise} + packaging ${b.packagingFeePaise}; discounts platform-funded)` },
    { _id: seedId(`ledger:commission:${co.key}:${c.key}`), ...base, accountType: 'RESTAURANT', accountId: restaurantId, entryType: 'COMMISSION', amountPaise: -commission, dedupeKey: `commission:${childOrderId}`, memo: `Platform commission ${c.restaurant.commissionBps} bps of ${b.itemsSubtotalPaise}` },
    { _id: seedId(`ledger:platform-commission:${co.key}:${c.key}`), ...base, accountType: 'PLATFORM', accountId: 'platform', entryType: 'COMMISSION', amountPaise: commission, dedupeKey: `platform-commission:${childOrderId}`, memo: `Commission from restaurant ${restaurantId}` },
    {
      _id: seedId(`ledger:delivery:${co.key}:${c.key}`), ...base, accountType: 'PARTNER', accountId: ids.user(c.outcome.partner), entryType: 'DELIVERY_EARNING',
      amountPaise: deliveryEarningPaise(c.distanceKm, cfg.PARTNER_BASE_PAYOUT_PAISE, cfg.PARTNER_PER_KM_PAISE),
      dedupeKey: `delivery:${jobId}`, memo: `Delivery earning (${c.distanceKm} km)`, deliveryJobId: jobId,
    },
  ];
}

export async function seedPayments(conn: Connection, cfg: PaymentsSeedConfig = { PARTNER_BASE_PAYOUT_PAISE: DEMO_PARTNER_PAYOUT.basePaise, PARTNER_PER_KM_PAISE: DEMO_PARTNER_PAYOUT.perKmPaise }): Promise<SeedReport> {
  const m = createModels(conn);
  createMockProvider({ conn, webhookSecret: 'seed-only-not-used-for-signing' }); // registers the mock gateway models
  const MockPayment = conn.models.MockProviderPayment!;
  const MockRefund = conn.models.MockProviderRefund!;
  const report: SeedReport = {};

  for (const co of DEMO_CHECKOUTS) {
    const { intent, mockPayment } = intentDocs(co);
    await ensureDocs(m.PaymentIntent, [intent], report);
    await ensureDocs(MockPayment, [mockPayment], report);
    for (const c of co.children) {
      if (demoRefundPaise(c) > 0) {
        const { refund, mockRefund } = refundDocs(co, c);
        await ensureDocs(m.Refund, [refund], report);
        await ensureDocs(MockRefund, [mockRefund], report);
      }
      await ensureDocs(m.LedgerEntry, ledgerDocs(co, c, cfg), report);
    }
  }

  const payoutId = seedId(`payout:${PAYOUT.key}`);
  const spiceRoute = seedId('restaurant:spice-route');
  const admin = seedId('user:admin');
  const requestedAt = new Date(PAYOUT.at.getTime() - 3_600_000);
  await ensureDocs(
    m.Payout,
    [
      {
        _id: payoutId,
        accountType: 'RESTAURANT',
        accountId: spiceRoute,
        amountPaise: PAYOUT.amountPaise,
        status: 'PAID',
        method: 'MANUAL_BANK_TRANSFER',
        utr: PAYOUT.utr,
        requestedBy: admin,
        confirmedBy: admin,
        confirmedAt: PAYOUT.at,
        notes: 'Demo settlement (recorded manual bank transfer)',
        isDemo: true,
        statusHistory: [
          { from: null, to: 'REQUESTED', at: requestedAt, source: `admin:${admin}` },
          { from: 'REQUESTED', to: 'PAID', at: PAYOUT.at, source: `admin:${admin}` },
        ],
        createdAt: requestedAt,
        updatedAt: PAYOUT.at,
      },
    ],
    report,
  );
  await ensureDocs(
    m.LedgerEntry,
    [
      {
        _id: seedId(`ledger:payout:${PAYOUT.key}`),
        accountType: 'RESTAURANT',
        accountId: spiceRoute,
        entryType: 'PAYOUT',
        amountPaise: -PAYOUT.amountPaise,
        dedupeKey: `payout:${payoutId}`,
        memo: `Manual bank transfer UTR ${PAYOUT.utr}`,
        createdBy: admin,
        payoutId,
        isDemo: true,
        createdAt: PAYOUT.at,
        updatedAt: PAYOUT.at,
      },
    ],
    report,
  );
  return report;
}

if (isMainModule(import.meta.url)) {
  void runSeedCli({
    service: 'payments',
    dbName: 'thali_payments',
    init: async (conn) => {
      createMockProvider({ conn, webhookSecret: 'seed-only-not-used-for-signing' });
      await initPayments({ conn, models: createModels(conn) } as unknown as PaymentsContext);
    },
    run: (conn) =>
      seedPayments(conn, {
        PARTNER_BASE_PAYOUT_PAISE: Number(process.env.PARTNER_BASE_PAYOUT_PAISE || DEMO_PARTNER_PAYOUT.basePaise),
        PARTNER_PER_KM_PAISE: Number(process.env.PARTNER_PER_KM_PAISE || DEMO_PARTNER_PAYOUT.perKmPaise),
      }),
  });
}
