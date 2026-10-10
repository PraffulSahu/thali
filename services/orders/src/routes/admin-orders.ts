/**
 * Admin order routes (LLD §10 orders 🛡 — ADMIN role + MFA; mutations audited in the same txn):
 *   GET  /admin/orders?q&status&restaurantId&userId&phone&from&to&cursor   child-order search
 *        (`phone`, or a `q` of 4–13 digits, matches the indexed `customerContact.phoneLast4` — ORD-7)
 *   GET  /admin/orders/checkouts?q&status&phone&restaurantId&from&to&cursor&limit   checkout rows (ORD-1)
 *   GET  /admin/orders/overview
 *   GET  /admin/orders/:checkoutId                 group + children + timeline + explanations
 *   POST /admin/orders/child/:childId/cancel {reason, refundPaise}       refundPaise ≤ remaining
 *   POST /admin/orders/child/:childId/transition {to, reason, prepMinutes?, refundPaise?}
 * The transition route only allows what the LLD §4.1 table grants ADMIN (`assertTransition`), so
 * SYSTEM-only moves (PICKED_UP, DELIVERED, …) are 409 even for admins.
 */
import express from 'express';
import { Types } from 'mongoose';
import { DomainError, type ChildOrderStatus } from '@thali/contracts';
import { auditEvent, buildPage, cursorFilter, PAGE_SORT, requireAuth, validate, withTransaction, type OpenApi } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import type { CheckoutGroup } from '../models/checkout-group.js';
import type { ChildOrder } from '../models/child-order.js';
import type { OrderEvent } from '../models/order-event.js';
import { PREP_MINUTES_MAX, PREP_MINUTES_MIN, transitionChild, type TransitionExtra } from '../domain/lifecycle.js';
import { adminChildRow, adminChildView, adminOrderDetail } from '../domain/order-views.js';
import { ordersOverview } from '../domain/stats.js';
import { listAdminCheckouts } from '../domain/admin-checkouts.js';
import { escapeRegex, phoneParamLast4, phoneTermLast4 } from '../domain/codes.js';
import {
  AdminCancelBody,
  AdminCheckoutPage,
  AdminCheckoutsQuery,
  AdminChildView,
  AdminOrderDetail,
  AdminOrderPage,
  AdminOrdersQuery,
  AdminTransitionBody,
  CheckoutIdParams,
  ChildIdParams,
  OrdersOverview,
  json,
} from '../order-schemas.js';
import type { RouteModule } from './types.js';

const BASE = '/api/v1/admin/orders';
const adminRead = () => requireAuth({ roles: ['ADMIN'], mfa: true });
const adminWrite = () => requireAuth({ roles: ['ADMIN'], mfa: true, adminRoles: ['OPS', 'SUPPORT', 'FINANCE'] });


async function searchFilter(ctx: OrdersContext, q: ReturnType<typeof parseQuery>): Promise<Record<string, unknown>> {
  const and: Record<string, unknown>[] = [];
  if (q.q) {
    const term = q.q.trim();
    const phone4 = phoneTermLast4(term);
    if (phone4) {
      and.push({ 'customerContact.phoneLast4': phone4 });
    } else if (/^TH-/i.test(term)) {
      const code = term.toUpperCase();
      const groups = await ctx.models.CheckoutGroup.find({ code }, { _id: 1 }).lean();
      and.push({ $or: [{ code }, { checkoutGroupId: { $in: groups.map((g) => g._id) } }] });
    } else if (Types.ObjectId.isValid(term) && /^[0-9a-f]{24}$/i.test(term)) {
      const id = new Types.ObjectId(term);
      and.push({ $or: [{ _id: id }, { checkoutGroupId: id }, { userId: term }, { restaurantId: term }] });
    } else {
      and.push({ restaurantName: { $regex: `^${escapeRegex(term)}`, $options: 'i' } });
    }
  }
  if (q.status?.length) and.push({ status: { $in: q.status } });
  if (q.restaurantId) and.push({ restaurantId: q.restaurantId });
  if (q.userId) and.push({ userId: q.userId });
  if (q.phone) {
    // only a masked contact snapshot is stored (`+91******3210`): match its (indexed) last 4 digits
    and.push({ 'customerContact.phoneLast4': phoneParamLast4(q.phone) });
  }
  if (q.from || q.to) and.push({ createdAt: { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lte: new Date(q.to) } : {}) } });
  return and.length ? { $and: and } : {};
}

const vList = validate({ query: AdminOrdersQuery });
const parseQuery = (req: express.Request) => vList.get(req).query;

async function audit(ctx: OrdersContext, session: Parameters<typeof auditEvent>[1], req: express.Request, action: string, child: ChildOrder, summary: string) {
  await auditEvent(ctx.conn, session, {
    service: 'orders',
    actorId: req.auth!.userId,
    actorRole: 'ADMIN',
    action,
    targetType: 'child_order',
    targetId: String(child._id),
    summary,
    ...(req.ip ? { ip: req.ip } : {}),
  });
}

function register(app: express.Express, ctx: OrdersContext): void {
  const r = express.Router();

  r.get('/', adminRead(), vList, async (req, res) => {
    const q = parseQuery(req);
    const filter = { ...(await searchFilter(ctx, q)), ...cursorFilter(q.cursor) };
    const docs = await ctx.models.ChildOrder.find(filter).sort(PAGE_SORT).limit(q.limit + 1).lean<ChildOrder[]>();
    res.json(buildPage(docs, q.limit, adminChildRow));
  });

  // ORD-1 — registered before '/:checkoutId'
  const vCheckouts = validate({ query: AdminCheckoutsQuery });
  r.get('/checkouts', adminRead(), vCheckouts, async (req, res) => {
    const q = vCheckouts.get(req).query;
    const term = q.q?.trim();
    const termPhone = term ? phoneTermLast4(term) : null;
    res.json(
      await listAdminCheckouts(ctx, {
        ...(term && !termPhone ? { q: term } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.phone ? { phone4: phoneParamLast4(q.phone) } : termPhone ? { phone4: termPhone } : {}),
        ...(q.restaurantId ? { restaurantId: q.restaurantId } : {}),
        ...(q.from ? { from: q.from } : {}),
        ...(q.to ? { to: q.to } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
        limit: q.limit,
      }),
    );
  });

  r.get('/overview', adminRead(), async (_req, res) => {
    res.json(await ordersOverview(ctx));
  });

  const vGet = validate({ params: CheckoutIdParams });
  r.get('/:checkoutId', adminRead(), vGet, async (req, res) => {
    const id = vGet.get(req).params.checkoutId;
    const g = await ctx.models.CheckoutGroup.findById(id).lean<CheckoutGroup>();
    if (!g) throw new DomainError('NOT_FOUND', 'Checkout not found');
    const [children, events] = await Promise.all([
      ctx.models.ChildOrder.find({ checkoutGroupId: g._id }).lean<ChildOrder[]>(),
      ctx.models.OrderEvent.find({ checkoutGroupId: g._id }).sort({ at: 1, _id: 1 }).limit(1000).lean<OrderEvent[]>(),
    ]);
    res.json(adminOrderDetail(g, children, events));
  });

  const vCancel = validate({ params: ChildIdParams, body: AdminCancelBody });
  r.post('/child/:childId/cancel', adminWrite(), vCancel, async (req, res) => {
    const { params, body } = vCancel.get(req);
    const child = await withTransaction(ctx.conn, async (session) => {
      const before = await ctx.models.ChildOrder.findById(params.childId, { status: 1 }).session(session).lean();
      const c = await transitionChild(ctx, session, params.childId, 'CANCELLED', {
        actor: 'ADMIN',
        actorId: req.auth!.userId,
        reason: body.reason,
        extra: { refundPaise: body.refundPaise },
      });
      await audit(ctx, session, req, 'order.cancel', c!, `Cancelled ${c!.code} (${before?.status ?? '?'} → CANCELLED), refund ${body.refundPaise} paise: ${body.reason}`);
      return c!;
    });
    res.json(adminChildView(child.toObject()));
  });

  const vTransition = validate({ params: ChildIdParams, body: AdminTransitionBody });
  r.post('/child/:childId/transition', adminWrite(), vTransition, async (req, res) => {
    const { params, body } = vTransition.get(req);
    if (body.to === 'CANCELLED' && body.refundPaise === undefined) {
      throw new DomainError('VALIDATION_FAILED', 'refundPaise is required to cancel', 400, {
        issues: [{ path: 'body.refundPaise', code: 'invalid_type', message: 'Required for to=CANCELLED' }],
      });
    }
    const child = await withTransaction(ctx.conn, async (session) => {
      const before = await ctx.models.ChildOrder.findById(params.childId, { status: 1, avgPrepMinutes: 1 }).session(session).lean();
      const extra: TransitionExtra = {};
      if (body.to === 'ACCEPTED') {
        const avg = before?.avgPrepMinutes ?? 20;
        extra.prepMinutes = body.prepMinutes ?? Math.min(PREP_MINUTES_MAX, Math.max(PREP_MINUTES_MIN, Math.round(avg)));
      }
      if (body.refundPaise !== undefined) extra.refundPaise = body.refundPaise;
      const c = await transitionChild(ctx, session, params.childId, body.to as ChildOrderStatus, {
        actor: 'ADMIN',
        actorId: req.auth!.userId,
        reason: body.reason,
        extra,
      });
      await audit(ctx, session, req, 'order.transition', c!, `Moved ${c!.code} ${before?.status ?? '?'} → ${body.to}: ${body.reason}`);
      return c!;
    });
    res.json(adminChildView(child.toObject()));
  });

  app.use(BASE, r);
}

function openapi(o: OpenApi): void {
  const tags = ['admin-orders'];
  o.route({
    method: 'get',
    path: BASE,
    tags,
    summary: 'Search child orders (code, ids, restaurant, customer phone, status, date range)',
    security: 'bearer',
    request: { query: AdminOrdersQuery },
    responses: { 200: { description: 'Page of child orders', content: json(AdminOrderPage) } },
    errors: ['MFA_REQUIRED'],
  });
  o.route({
    method: 'get',
    path: `${BASE}/checkouts`,
    tags,
    summary: 'Checkout-level order list (one row per checkout: restaurants, derived status, paid/refund totals, attention)',
    description:
      'Newest placed first (`placedAt desc`). Without `status` only placed checkouts are listed; never-placed ones ' +
      '(AWAITING_PAYMENT / PAYMENT_FAILED / EXPIRED) appear only when asked for and sort last. A `q` of 4–13 digits is a phone search.',
    security: 'bearer',
    request: { query: AdminCheckoutsQuery },
    responses: { 200: { description: 'Page of checkouts', content: json(AdminCheckoutPage) } },
    errors: ['MFA_REQUIRED'],
  });
  o.route({
    method: 'get',
    path: `${BASE}/overview`,
    tags,
    summary: 'Operational order metrics (today in Asia/Kolkata, active orders, overdue acceptance, refunds pending)',
    security: 'bearer',
    responses: { 200: { description: 'Overview', content: json(OrdersOverview) } },
    errors: ['MFA_REQUIRED'],
  });
  o.route({
    method: 'get',
    path: `${BASE}/:checkoutId`,
    tags,
    summary: 'Investigate a checkout: children (all fields), timeline, explanations, adjusted totals',
    security: 'bearer',
    request: { params: CheckoutIdParams },
    responses: { 200: { description: 'Checkout detail', content: json(AdminOrderDetail) } },
    errors: ['NOT_FOUND', 'MFA_REQUIRED'],
  });
  o.route({
    method: 'post',
    path: `${BASE}/child/:childId/cancel`,
    tags,
    summary: 'Cancel a child order with a refund (≤ remaining refundable); audited',
    description: 'Allowed from PLACED, ACCEPTED, PREPARING, READY_FOR_PICKUP and DELIVERY_FAILED (LLD §4.1).',
    security: 'bearer',
    request: { params: ChildIdParams, body: { content: json(AdminCancelBody) } },
    responses: { 200: { description: 'Cancelled child', content: json(AdminChildView) } },
    errors: ['NOT_FOUND', 'ORDER_INVALID_TRANSITION', 'REFUND_EXCEEDS_REMAINING', 'MFA_REQUIRED'],
  });
  o.route({
    method: 'post',
    path: `${BASE}/child/:childId/transition`,
    tags,
    summary: 'Apply a transition the state machine allows for ADMIN; audited',
    security: 'bearer',
    request: { params: ChildIdParams, body: { content: json(AdminTransitionBody) } },
    responses: { 200: { description: 'Updated child', content: json(AdminChildView) } },
    errors: ['NOT_FOUND', 'ORDER_INVALID_TRANSITION', 'REFUND_EXCEEDS_REMAINING', 'MFA_REQUIRED'],
  });
}

export const adminOrdersModule: RouteModule = { name: 'admin-orders', register, openapi };
