/**
 * 🛡 admin finance: ADMIN + MFA with adminRoles FINANCE or SUPER_ADMIN (claim `adm`). Refund creation and
 * payout recording require Idempotency-Key (LLD §1.4); every mutation is audited in its transaction.
 */
import express, { type Request, type Router } from 'express';
import { formatINR } from '@thali/contracts';
import { PAGE_SORT, auditEvent, buildPage, cursorFilter, idempotency, requireAuth, validate, withTransaction } from '@thali/service-kit';
import { isValidObjectId } from 'mongoose';
import type { PaymentsContext } from '../context.js';
import { paymentStatusView } from '../domain/intents.js';
import { listBalances } from '../domain/ledger.js';
import { confirmPayout, failPayout, payoutView, requestPayout, type Actor } from '../domain/payouts.js';
import { adminRetryRefund, refundView, requestRefund } from '../domain/refunds.js';
import type { PaymentIntentDoc } from '../models/payment-intent.js';
import {
  BalancesQuery,
  ManualRefundBody,
  PaymentsSearchQuery,
  PayoutConfirmBody,
  PayoutCreateBody,
  PayoutFailBody,
  PayoutIdParams,
  PayoutListQuery,
  RefundIdParams,
  RefundListQuery,
} from '../schemas.js';

const actorOf = (req: Request): Actor => ({
  userId: req.auth!.userId,
  adminRoles: req.auth!.adminRoles ?? [],
  ...(req.ip ? { ip: req.ip } : {}),
});
const roleOf = (a: Actor) => `ADMIN:${a.adminRoles.join('|') || 'ADMIN'}`;

export function adminFinanceRouter(ctx: PaymentsContext): Router {
  const r = express.Router();
  const guard = requireAuth({ roles: ['ADMIN'], mfa: true, adminRoles: ['FINANCE', 'SUPER_ADMIN'] });
  const base = '/api/v1/admin/finance';

  // ---- refunds ----
  const vRefunds = validate({ query: RefundListQuery });
  r.get(`${base}/refunds`, guard, vRefunds, async (req, res) => {
    const { query } = vRefunds.get(req);
    const docs = await ctx.models.Refund.find({ ...(query.status ? { status: query.status } : {}), ...cursorFilter(query.cursor) })
      .sort(PAGE_SORT)
      .limit(query.limit + 1)
      .lean();
    res.json(buildPage(docs, query.limit, (d) => refundView(d as never)));
  });

  const vRetry = validate({ params: RefundIdParams });
  r.post(`${base}/refunds/:id/retry`, guard, vRetry, async (req, res) => {
    const actor = actorOf(req);
    const { params } = vRetry.get(req);
    const refund = await adminRetryRefund(ctx, params.id, actor, async (session, rf) => {
      await auditEvent(ctx.conn, session, {
        service: 'payments',
        actorId: actor.userId,
        actorRole: roleOf(actor),
        action: 'refund.manual_retry',
        targetType: 'refund',
        targetId: rf.id as string,
        summary: `Manual retry of refund ${formatINR(rf.amountPaise)} (attempts ${rf.attempts})`,
        ...(actor.ip ? { ip: actor.ip } : {}),
      });
    });
    res.json(refundView(refund));
  });

  const vManual = validate({ body: ManualRefundBody });
  r.post(`${base}/refunds`, guard, idempotency({ scope: 'admin-refund', conn: ctx.conn }), vManual, async (req, res) => {
    const actor = actorOf(req);
    const { body } = vManual.get(req);
    const key = req.header('idempotency-key')!;
    const refund = await withTransaction(ctx.conn, async (session) => {
      const intent = await ctx.models.PaymentIntent.findById(body.paymentIntentId).session(session);
      const { refund: rf } = await requestRefund(ctx, session, {
        paymentIntentId: body.paymentIntentId,
        checkoutGroupId: intent?.referenceId ?? body.paymentIntentId,
        childOrderId: body.childOrderId ?? null,
        restaurantId: body.restaurantId ?? null,
        amountPaise: body.amountPaise,
        reason: body.reason,
        idempotencyKey: `refund:admin:${actor.userId}:${key}`,
        requestedBy: `admin:${actor.userId}`,
        note: body.note,
        chargeRestaurantPaise: body.chargeRestaurantPaise,
        strict: true,
      });
      await auditEvent(ctx.conn, session, {
        service: 'payments',
        actorId: actor.userId,
        actorRole: roleOf(actor),
        action: 'refund.create',
        targetType: 'refund',
        targetId: rf.id as string,
        summary: `Manual refund ${formatINR(body.amountPaise)} on payment ${body.paymentIntentId}${
          body.chargeRestaurantPaise ? ` (restaurant charged ${formatINR(body.chargeRestaurantPaise)})` : ''
        }: ${body.note}`,
        ...(actor.ip ? { ip: actor.ip } : {}),
      });
      return rf;
    });
    res.status(201).json(refundView(refund));
  });

  // ---- balances ----
  const vBalances = validate({ query: BalancesQuery });
  r.get(`${base}/balances`, guard, vBalances, async (req, res) => {
    const { query } = vBalances.get(req);
    res.json(await listBalances(ctx, query.accountType, { limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) }));
  });

  // ---- payouts ----
  const vPayout = validate({ body: PayoutCreateBody });
  r.post(`${base}/payouts`, guard, idempotency({ scope: 'admin-payout', conn: ctx.conn }), vPayout, async (req, res) => {
    const { body } = vPayout.get(req);
    const payout = await requestPayout(ctx, { ...body, notes: body.notes ?? null }, actorOf(req));
    res.status(201).json(payoutView(payout));
  });

  const vPayouts = validate({ query: PayoutListQuery });
  r.get(`${base}/payouts`, guard, vPayouts, async (req, res) => {
    const { query } = vPayouts.get(req);
    const filter = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.accountType ? { accountType: query.accountType } : {}),
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...cursorFilter(query.cursor),
    };
    const docs = await ctx.models.Payout.find(filter).sort(PAGE_SORT).limit(query.limit + 1).lean();
    res.json(buildPage(docs, query.limit, payoutView));
  });

  const vConfirm = validate({ params: PayoutIdParams, body: PayoutConfirmBody });
  r.post(`${base}/payouts/:id/confirm`, guard, vConfirm, async (req, res) => {
    const { params, body } = vConfirm.get(req);
    res.json(payoutView(await confirmPayout(ctx, params.id, body.utr, actorOf(req))));
  });

  const vFail = validate({ params: PayoutIdParams, body: PayoutFailBody });
  r.post(`${base}/payouts/:id/fail`, guard, vFail, async (req, res) => {
    const { params, body } = vFail.get(req);
    res.json(payoutView(await failPayout(ctx, params.id, body.reason, actorOf(req))));
  });

  // ---- payments search ----
  const vSearch = validate({ query: PaymentsSearchQuery });
  r.get(`${base}/payments`, guard, vSearch, async (req, res) => {
    const { query } = vSearch.get(req);
    const q = query.q;
    const filter: Record<string, unknown> = {
      ...(query.status ? { status: query.status } : {}),
      ...(q
        ? {
            $or: [
              ...(isValidObjectId(q) ? [{ _id: q }] : []),
              { referenceId: q },
              { providerOrderId: q },
              { providerPaymentId: q },
              { userId: q },
            ],
          }
        : {}),
      ...cursorFilter(query.cursor),
    };
    const docs = await ctx.models.PaymentIntent.find(filter).sort(PAGE_SORT).limit(query.limit + 1);
    res.json(
      buildPage(docs, query.limit, (d: PaymentIntentDoc) => ({
        ...paymentStatusView(ctx, d),
        userId: d.userId,
        providerPaymentId: d.providerPaymentId ?? null,
        refundReservedPaise: d.refundReservedPaise,
        lastReconciledAt: d.lastReconciledAt ? d.lastReconciledAt.toISOString() : null,
        createdAt: d.createdAt.toISOString(),
      })),
    );
  });
  return r;
}
