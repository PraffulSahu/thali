/**
 * Customer order routes (LLD §10 orders 👤):
 *   GET  /orders                         my checkouts (paginated, newest first) with child summaries
 *   GET  /orders/:checkoutId             group + children + explanations[] + adjustedTotals
 *   POST /orders/child/:childId/cancel   PLACED → CANCELLED (full child refund)
 *   POST /orders/:checkoutId/reorder     add available lines to the cart; changes[]
 * Ownership: every lookup is scoped to `req.auth.userId` (someone else's order → 404).
 */
import express from 'express';
import { Types } from 'mongoose';
import { DomainError } from '@thali/contracts';
import { buildPage, cursorFilter, PAGE_SORT, requireAuth, validate, withTransaction, type OpenApi } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import type { CheckoutGroup } from '../models/checkout-group.js';
import type { ChildOrder } from '../models/child-order.js';
import { transitionChild } from '../domain/lifecycle.js';
import { customerChildView, customerOrderDetail, orderSummary } from '../domain/order-views.js';
import { reorder } from '../domain/reorder.js';
import {
  CheckoutIdParams,
  ChildIdParams,
  CustomerCancelBody,
  CustomerChildView,
  MyOrdersQuery,
  OrderDetail,
  OrderPage,
  ReorderResponse,
  json,
} from '../order-schemas.js';
import type { RouteModule } from './types.js';

const BASE = '/api/v1/orders';

export async function loadCustomerOrder(ctx: OrdersContext, userId: string, checkoutId: string) {
  const g = Types.ObjectId.isValid(checkoutId) ? await ctx.models.CheckoutGroup.findOne({ _id: checkoutId, userId }).lean<CheckoutGroup>() : null;
  if (!g) throw new DomainError('NOT_FOUND', 'Order not found');
  const children = await ctx.models.ChildOrder.find({ checkoutGroupId: g._id }).lean<ChildOrder[]>();
  return { g, children };
}

function register(app: express.Express, ctx: OrdersContext): void {
  const r = express.Router();

  const vList = validate({ query: MyOrdersQuery });
  r.get('/', requireAuth(), vList, async (req, res) => {
    const { limit, cursor, status } = vList.get(req).query;
    const filter: Record<string, unknown> = { userId: req.auth!.userId, ...cursorFilter(cursor) };
    if (status) filter.status = status;
    const groups = await ctx.models.CheckoutGroup.find(filter).sort(PAGE_SORT).limit(limit + 1).lean<CheckoutGroup[]>();
    const page = groups.slice(0, limit);
    const children = page.length ? await ctx.models.ChildOrder.find({ checkoutGroupId: { $in: page.map((g) => g._id) } }).lean<ChildOrder[]>() : [];
    const byGroup = new Map<string, ChildOrder[]>();
    for (const c of children) {
      const k = String(c.checkoutGroupId);
      byGroup.set(k, [...(byGroup.get(k) ?? []), c]);
    }
    res.json(buildPage(groups, limit, (g) => orderSummary(g, byGroup.get(String(g._id)) ?? [])));
  });

  const vGet = validate({ params: CheckoutIdParams });
  r.get('/:checkoutId', requireAuth(), vGet, async (req, res) => {
    const { g, children } = await loadCustomerOrder(ctx, req.auth!.userId, vGet.get(req).params.checkoutId);
    res.json(customerOrderDetail(g, children));
  });

  const vCancel = validate({ params: ChildIdParams, body: CustomerCancelBody });
  r.post('/child/:childId/cancel', requireAuth(), vCancel, async (req, res) => {
    const { params, body } = vCancel.get(req);
    const userId = req.auth!.userId;
    const child = await withTransaction(ctx.conn, (session) =>
      transitionChild(ctx, session, params.childId, 'CANCELLED', {
        actor: 'CUSTOMER',
        actorId: userId,
        reason: body.reason ?? 'Cancelled by customer',
        scope: { userId },
      }),
    );
    res.json(customerChildView(child!.toObject()));
  });

  const vReorder = validate({ params: CheckoutIdParams });
  r.post('/:checkoutId/reorder', requireAuth(), vReorder, async (req, res) => {
    res.json(await reorder(ctx, req.auth!.userId, vReorder.get(req).params.checkoutId));
  });

  app.use(BASE, r);
}

function openapi(o: OpenApi): void {
  o.route({
    method: 'get',
    path: BASE,
    tags: ['orders'],
    summary: 'My orders (checkout groups, newest first)',
    security: 'bearer',
    request: { query: MyOrdersQuery },
    responses: { 200: { description: 'Page of orders', content: json(OrderPage) } },
  });
  o.route({
    method: 'get',
    path: `${BASE}/:checkoutId`,
    tags: ['orders'],
    summary: 'Order detail: one child per restaurant, explanations for rejected/cancelled parts, adjusted totals',
    description:
      'adjustedTotals.netPaise = paid − refunded; refundPendingPaise covers refunds requested but not yet completed. ' +
      'explanations[] tells the customer why part of the purchase will not arrive and what happens to the money.',
    security: 'bearer',
    request: { params: CheckoutIdParams },
    responses: { 200: { description: 'Order', content: json(OrderDetail) } },
    errors: ['NOT_FOUND'],
  });
  o.route({
    method: 'post',
    path: `${BASE}/child/:childId/cancel`,
    tags: ['orders'],
    summary: 'Cancel one restaurant order before the restaurant accepts it (full refund of that child)',
    security: 'bearer',
    request: { params: ChildIdParams, body: { content: json(CustomerCancelBody) } },
    responses: { 200: { description: 'Cancelled child order', content: json(CustomerChildView) } },
    errors: ['NOT_FOUND', 'ORDER_INVALID_TRANSITION'],
  });
  o.route({
    method: 'post',
    path: `${BASE}/:checkoutId/reorder`,
    tags: ['orders'],
    summary: 'Reorder: add the still-available lines to my cart and report what changed',
    security: 'bearer',
    request: { params: CheckoutIdParams },
    responses: { 200: { description: 'Cart after reorder + changes', content: json(ReorderResponse) } },
    errors: ['NOT_FOUND', 'UPSTREAM_ERROR'],
  });
}

export const ordersModule: RouteModule = { name: 'orders', register, openapi };
