/**
 * Internal routes (service tokens only; binding shapes in docs/03-LLD.md):
 *   GET  /internal/checkouts/:id/status → { id, status, paymentIntentId }   (marketplace sweeper)
 *   POST /internal/cart/merge {userId, guestToken} → { merged, lineCount } (identity on OTP login)
 * Task 12 adds `/internal/orders/child/:id` and `/internal/orders/stats` in its own module.
 * Ops routes (`/internal/health/details`, dead letters) are mounted by app.ts via service-kit.
 */
import express from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { DomainError } from '@thali/contracts';
import { requireInternal, validate, type OpenApi } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import { mergeGuestCart } from '../domain/cart.js';
import type { CheckoutGroup } from '../models/checkout-group.js';
import { CheckoutStatusResponse, InternalMergeBody, MergeResponse } from '../schemas.js';
import type { RouteModule } from './types.js';

const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
const StatusParams = z.object({ id: z.string().min(1).max(64) });

function register(app: express.Express, ctx: OrdersContext): void {
  const r = express.Router();

  const vStatus = validate({ params: StatusParams });
  r.get('/internal/checkouts/:id/status', requireInternal(['marketplace', 'payments']), vStatus, async (req, res) => {
    const { id } = vStatus.get(req).params;
    const g = Types.ObjectId.isValid(id)
      ? await ctx.models.CheckoutGroup.findById(id, { status: 1, paymentIntentId: 1 }).lean<Pick<CheckoutGroup, '_id' | 'status' | 'paymentIntentId'>>()
      : null;
    if (!g) throw new DomainError('NOT_FOUND', 'Checkout not found');
    res.json({ id: String(g._id), status: g.status, paymentIntentId: g.paymentIntentId ?? null });
  });

  const vMerge = validate({ body: InternalMergeBody });
  r.post('/internal/cart/merge', requireInternal(['identity']), vMerge, async (req, res) => {
    const { userId, guestToken } = vMerge.get(req).body;
    res.json(await mergeGuestCart(ctx, userId, guestToken));
  });

  app.use(r);
}

function openapi(o: OpenApi): void {
  o.route({
    method: 'get',
    path: '/internal/checkouts/:id/status',
    tags: ['internal'],
    summary: 'Checkout status for the marketplace reservation sweeper',
    security: 'internal',
    request: { params: StatusParams },
    responses: { 200: { description: 'Status', content: json(CheckoutStatusResponse) } },
    errors: ['NOT_FOUND'],
  });
  o.route({
    method: 'post',
    path: '/internal/cart/merge',
    tags: ['internal'],
    summary: 'Merge a guest cart into a user cart (identity, after OTP login); idempotent',
    security: 'internal',
    request: { body: { content: json(InternalMergeBody) } },
    responses: { 200: { description: 'Merge result', content: json(MergeResponse) } },
  });
}

export const internalModule: RouteModule = { name: 'internal', register, openapi };
