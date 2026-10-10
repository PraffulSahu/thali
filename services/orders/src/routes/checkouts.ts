/**
 * Checkout routes (LLD §8, §10): 👤 POST /checkouts (Idempotency-Key, 10/min/user), GET /checkouts/:id.
 */
import express from 'express';
import { z } from 'zod';
import { idempotency, rateLimit, requireAuth, validate, type OpenApi } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import { createCheckout, getCheckoutView } from '../domain/checkout.js';
import { CheckoutGetResponse, CheckoutResponse, CreateCheckoutBody, IdParams } from '../schemas.js';
import type { RouteModule } from './types.js';

const BASE = '/api/v1/checkouts';
const json = (schema: z.ZodType) => ({ 'application/json': { schema } });

function register(app: express.Express, ctx: OrdersContext): void {
  const r = express.Router();
  const vCreate = validate({ body: CreateCheckoutBody });
  r.post(
    '/',
    requireAuth(),
    rateLimit({
      redis: ctx.redis,
      name: 'checkout-create',
      keyFn: (req) => req.auth?.userId ?? null,
      points: ctx.config.CHECKOUT_RATE_LIMIT_PER_MIN,
      durationSec: 60,
    }),
    idempotency({ scope: 'checkout', conn: ctx.conn }),
    vCreate,
    async (req, res) => {
      const result = await createCheckout(ctx, {
        userId: req.auth!.userId,
        body: vCreate.get(req).body,
        idempotencyKey: req.header('idempotency-key') ?? null,
      });
      res.status(result.status).json(result.body);
    },
  );

  const vGet = validate({ params: IdParams });
  r.get('/:id', requireAuth(), vGet, async (req, res) => {
    res.json(await getCheckoutView(ctx, req.auth!.userId, vGet.get(req).params.id));
  });

  app.use(BASE, r);
}

function openapi(o: OpenApi): void {
  o.route({
    method: 'post',
    path: BASE,
    tags: ['checkouts'],
    summary: 'Create a multi-restaurant checkout (reserve stock, create payment intent)',
    description:
      'LLD §8 saga. One child order per restaurant, each delivered separately. Returns 201 for a new checkout; ' +
      '200 with the existing AWAITING_PAYMENT checkout when the same cart version was already submitted (different key). ' +
      'The cart is cleared only after payment is captured.',
    security: 'bearer',
    idempotent: true,
    rateLimited: true,
    request: { body: { content: json(CreateCheckoutBody) } },
    responses: {
      201: { description: 'Checkout created', content: json(CheckoutResponse) },
      200: { description: 'Existing checkout for this cart version', content: json(CheckoutResponse) },
    },
    errors: [
      'CART_EMPTY',
      'RESTAURANT_CLOSED',
      'NOT_SERVICEABLE',
      'ITEM_UNAVAILABLE',
      'INVALID_SELECTION',
      'PRICE_CHANGED',
      'COUPON_INVALID',
      'COUPON_LIMIT_REACHED',
      'OUT_OF_STOCK',
      'PAYMENT_PROVIDER_UNAVAILABLE',
      'UPSTREAM_TIMEOUT',
    ],
  });
  o.route({
    method: 'get',
    path: `${BASE}/:id`,
    tags: ['checkouts'],
    summary: 'Get my checkout (poll for payment result)',
    security: 'bearer',
    request: { params: IdParams },
    responses: { 200: { description: 'Checkout', content: json(CheckoutGetResponse) } },
    errors: ['NOT_FOUND'],
  });
}

export const checkoutsModule: RouteModule = { name: 'checkouts', register, openapi };
