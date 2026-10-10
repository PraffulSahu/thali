/**
 * Restaurant owner routes (LLD §10 orders 🍽; RESTAURANT_OWNER + ownership):
 *   GET   /owner/orders?restaurantId&status&cursor   my restaurants' child orders (newest first)
 *   GET   /owner/orders/stats?restaurantId&from&to   same shape as the internal stats
 *   GET   /owner/orders/:childId
 *   POST  /owner/orders/:childId/accept {prepMinutes 5–120}
 *   POST  /owner/orders/:childId/reject {reason}
 *   POST  /owner/orders/:childId/preparing
 *   POST  /owner/orders/:childId/ready
 *   PATCH /owner/orders/:childId/prep-time {prepMinutes}   minutes from now (ACCEPTED/PREPARING only)
 * Ownership = `child.restaurantOwnerId === auth.userId` (otherwise 404, never 403, so ids don't leak).
 * Every state change goes through `transitionChild` (actor RESTAURANT).
 */
import express from 'express';
import { DomainError, type ChildOrderStatus } from '@thali/contracts';
import { buildPage, cursorFilter, PAGE_SORT, requireAuth, validate, withTransaction, type OpenApi } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import type { ChildOrder } from '../models/child-order.js';
import { appendOrderEvents } from '../models/order-event.js';
import { loadChildFor, queueOwnerOrder, transitionChild } from '../domain/lifecycle.js';
import { ownerOrderView } from '../domain/order-views.js';
import { publishChildUpdate } from '../domain/place.js';
import { restaurantStats } from '../domain/stats.js';
import {
  AcceptBody,
  ChildIdParams,
  OwnerOrderPage,
  OwnerOrderView,
  OwnerOrdersQuery,
  PrepTimeBody,
  RejectBody,
  RestaurantStatsView,
  StatsQuery,
  json,
} from '../order-schemas.js';
import type { RouteModule } from './types.js';

const BASE = '/api/v1/owner/orders';
const ownerOnly = () => requireAuth({ roles: ['RESTAURANT_OWNER'] });

function register(app: express.Express, ctx: OrdersContext): void {
  const r = express.Router();

  const vList = validate({ query: OwnerOrdersQuery });
  r.get('/', ownerOnly(), vList, async (req, res) => {
    const { limit, cursor, restaurantId, status } = vList.get(req).query;
    const filter: Record<string, unknown> = { restaurantOwnerId: req.auth!.userId, status: { $ne: 'AWAITING_PAYMENT' }, ...cursorFilter(cursor) };
    if (restaurantId) filter.restaurantId = restaurantId;
    if (status?.length) filter.status = { $in: status.filter((s) => s !== 'AWAITING_PAYMENT') };
    const docs = await ctx.models.ChildOrder.find(filter).sort(PAGE_SORT).limit(limit + 1).lean<ChildOrder[]>();
    res.json(buildPage(docs, limit, ownerOrderView));
  });

  // must be registered before '/:childId'
  const vStats = validate({ query: StatsQuery });
  r.get('/stats', ownerOnly(), vStats, async (req, res) => {
    const q = vStats.get(req).query;
    res.json(await restaurantStats(ctx, { restaurantId: q.restaurantId, from: new Date(q.from), to: new Date(q.to), restaurantOwnerId: req.auth!.userId }));
  });

  const vGet = validate({ params: ChildIdParams });
  r.get('/:childId', ownerOnly(), vGet, async (req, res) => {
    const child = await loadChildFor(ctx, vGet.get(req).params.childId, { restaurantOwnerId: req.auth!.userId });
    if (child.status === 'AWAITING_PAYMENT') throw new DomainError('NOT_FOUND', 'Order not found');
    res.json(ownerOrderView(child.toObject()));
  });

  const act = (to: ChildOrderStatus, extra: (body: Record<string, unknown>) => { reason?: string; prepMinutes?: number }) => {
    return async (req: express.Request, res: express.Response) => {
      const childId = String(req.params.childId);
      const userId = req.auth!.userId;
      const body = (req.valid.body ?? {}) as Record<string, unknown>;
      const { reason, prepMinutes } = extra(body);
      const child = await withTransaction(ctx.conn, (session) =>
        transitionChild(ctx, session, childId, to, {
          actor: 'RESTAURANT',
          actorId: userId,
          reason: reason ?? null,
          scope: { restaurantOwnerId: userId },
          extra: prepMinutes !== undefined ? { prepMinutes } : {},
        }),
      );
      res.json(ownerOrderView(child!.toObject()));
    };
  };

  r.post('/:childId/accept', ownerOnly(), validate({ params: ChildIdParams, body: AcceptBody }), act('ACCEPTED', (b) => ({ prepMinutes: b.prepMinutes as number })));
  r.post('/:childId/reject', ownerOnly(), validate({ params: ChildIdParams, body: RejectBody }), act('REJECTED', (b) => ({ reason: b.reason as string })));
  r.post('/:childId/preparing', ownerOnly(), validate({ params: ChildIdParams }), act('PREPARING', () => ({})));
  r.post('/:childId/ready', ownerOnly(), validate({ params: ChildIdParams }), act('READY_FOR_PICKUP', () => ({})));

  const vPrep = validate({ params: ChildIdParams, body: PrepTimeBody });
  r.patch('/:childId/prep-time', ownerOnly(), vPrep, async (req, res) => {
    const { params, body } = vPrep.get(req);
    const userId = req.auth!.userId;
    const child = await withTransaction(ctx.conn, async (session) => {
      const c = await loadChildFor(ctx, params.childId, { restaurantOwnerId: userId }, session);
      if (c.status !== 'ACCEPTED' && c.status !== 'PREPARING') {
        throw new DomainError('CONFLICT', `Preparation time can only change while ACCEPTED or PREPARING (now ${c.status})`, 409, { status: c.status });
      }
      const at = new Date();
      c.prepMinutes = body.prepMinutes;
      c.readyEta = new Date(at.getTime() + body.prepMinutes * 60_000);
      await c.save({ session });
      await appendOrderEvents(ctx.conn, session, [
        {
          checkoutGroupId: c.checkoutGroupId,
          childOrderId: c._id,
          type: 'order.prep_time_updated',
          actor: 'RESTAURANT',
          actorId: userId,
          data: { prepMinutes: body.prepMinutes, readyEta: c.readyEta },
          at,
        },
      ]);
      const group = await ctx.models.CheckoutGroup.findById(c.checkoutGroupId).session(session);
      if (group) publishChildUpdate(ctx, session, group, c);
      queueOwnerOrder(ctx, session, c);
      return c;
    });
    res.json(ownerOrderView(child.toObject()));
  });

  app.use(BASE, r);
}

function openapi(o: OpenApi): void {
  const tags = ['owner-orders'];
  const one = { 200: { description: 'Child order (restaurant view)', content: json(OwnerOrderView) } };
  o.route({
    method: 'get',
    path: BASE,
    tags,
    summary: "My restaurants' orders (newest first)",
    description: 'Only orders of restaurants owned by the caller. `status` accepts a comma-separated list.',
    security: 'bearer',
    request: { query: OwnerOrdersQuery },
    responses: { 200: { description: 'Page of orders', content: json(OwnerOrderPage) } },
  });
  o.route({
    method: 'get',
    path: `${BASE}/stats`,
    tags,
    summary: 'Order stats for one of my restaurants (window on placedAt)',
    security: 'bearer',
    request: { query: StatsQuery },
    responses: { 200: { description: 'Stats', content: json(RestaurantStatsView) } },
  });
  o.route({ method: 'get', path: `${BASE}/:childId`, tags, summary: 'One of my orders', security: 'bearer', request: { params: ChildIdParams }, responses: one, errors: ['NOT_FOUND'] });
  o.route({
    method: 'post',
    path: `${BASE}/:childId/accept`,
    tags,
    summary: 'Accept (PLACED → ACCEPTED) within the acceptance window; creates the delivery job',
    security: 'bearer',
    request: { params: ChildIdParams, body: { content: json(AcceptBody) } },
    responses: one,
    errors: ['NOT_FOUND', 'ORDER_INVALID_TRANSITION', 'ORDER_ACCEPT_WINDOW_EXPIRED'],
  });
  o.route({
    method: 'post',
    path: `${BASE}/:childId/reject`,
    tags,
    summary: 'Reject with a reason (PLACED → REJECTED); the customer is refunded this restaurant’s part',
    security: 'bearer',
    request: { params: ChildIdParams, body: { content: json(RejectBody) } },
    responses: one,
    errors: ['NOT_FOUND', 'ORDER_INVALID_TRANSITION', 'ORDER_ACCEPT_WINDOW_EXPIRED'],
  });
  o.route({
    method: 'post',
    path: `${BASE}/:childId/preparing`,
    tags,
    summary: 'Start preparing (ACCEPTED → PREPARING)',
    security: 'bearer',
    request: { params: ChildIdParams },
    responses: one,
    errors: ['NOT_FOUND', 'ORDER_INVALID_TRANSITION'],
  });
  o.route({
    method: 'post',
    path: `${BASE}/:childId/ready`,
    tags,
    summary: 'Ready for pickup (ACCEPTED/PREPARING → READY_FOR_PICKUP)',
    security: 'bearer',
    request: { params: ChildIdParams },
    responses: one,
    errors: ['NOT_FOUND', 'ORDER_INVALID_TRANSITION'],
  });
  o.route({
    method: 'patch',
    path: `${BASE}/:childId/prep-time`,
    tags,
    summary: 'Update preparation time (minutes from now) while ACCEPTED or PREPARING',
    security: 'bearer',
    request: { params: ChildIdParams, body: { content: json(PrepTimeBody) } },
    responses: one,
    errors: ['NOT_FOUND', 'CONFLICT'],
  });
}

export const ownerOrdersModule: RouteModule = { name: 'owner-orders', register, openapi };
