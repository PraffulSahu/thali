/**
 * Cart routes (LLD §10 orders): guest (X-Guest-Cart) or signed-in user.
 *   GET /cart · POST /cart/items · PATCH|DELETE /cart/items/:lineId · DELETE /cart · POST /cart/guest
 *   PUT /cart/address · PUT /cart/coupon · 👤 POST /cart/merge · 👤 POST /cart/preview
 */
import express from 'express';
import { z } from 'zod';
import { rateLimit, requireAuth, validate } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import {
  addItem,
  cartView,
  clearCart,
  findCart,
  mergeGuestCart,
  removeLine,
  resolveCartOwner,
  setAddress,
  setCoupon,
  updateLine,
} from '../domain/cart.js';
import { previewCart } from '../domain/checkout.js';
import { generateGuestToken, hashGuestToken } from '../domain/guest-token.js';
import {
  AddItemResponse,
  CartItemInput,
  CartItemUpdate,
  CartView,
  GuestHeader,
  GuestTokenResponse,
  LineIdParams,
  MergeBody,
  MergeResponse,
  PreviewBody,
  PreviewResponse,
  SetAddressBody,
  SetCouponBody,
} from '../schemas.js';
import type { RouteModule } from './types.js';

const BASE = '/api/v1/cart';
const json = (schema: z.ZodType) => ({ 'application/json': { schema } });

function register(app: express.Express, ctx: OrdersContext): void {
  const r = express.Router();
  const optionalAuth = requireAuth({ optional: true });
  const view = (cart: Parameters<typeof cartView>[0], owner: ReturnType<typeof resolveCartOwner>) =>
    cartView(cart, owner.kind === 'USER' ? 'USER' : 'GUEST');

  r.get('/', optionalAuth, async (req, res) => {
    const owner = resolveCartOwner(req);
    res.json(view(await findCart(ctx, owner), owner));
  });

  r.post(
    '/guest',
    rateLimit({ redis: ctx.redis, name: 'guest-cart', keyFn: (req) => req.ip ?? null, points: 30, durationSec: 60, failOpen: true }),
    async (_req, res) => {
      const guestToken = generateGuestToken();
      const expiresAt = new Date(Date.now() + ctx.config.GUEST_CART_TTL_DAYS * 86_400_000);
      await ctx.models.Cart.create({ ownerType: 'GUEST', guestTokenHash: hashGuestToken(guestToken), items: [], cartVersion: 0, expiresAt });
      res.status(201).json({ guestToken, expiresAt: expiresAt.toISOString() });
    },
  );

  const vAdd = validate({ body: CartItemInput });
  r.post('/items', optionalAuth, vAdd, async (req, res) => {
    const owner = resolveCartOwner(req);
    const { cart, lineId } = await addItem(ctx, owner, vAdd.get(req).body);
    res.status(201).json({ lineId, cart: view(cart, owner) });
  });

  const vUpdate = validate({ params: LineIdParams, body: CartItemUpdate });
  r.patch('/items/:lineId', optionalAuth, vUpdate, async (req, res) => {
    const owner = resolveCartOwner(req);
    const { params, body } = vUpdate.get(req);
    res.json(view(await updateLine(ctx, owner, params.lineId, body), owner));
  });

  const vLine = validate({ params: LineIdParams });
  r.delete('/items/:lineId', optionalAuth, vLine, async (req, res) => {
    const owner = resolveCartOwner(req);
    res.json(view(await removeLine(ctx, owner, vLine.get(req).params.lineId), owner));
  });

  r.delete('/', optionalAuth, async (req, res) => {
    const owner = resolveCartOwner(req);
    res.json(view(await clearCart(ctx, owner), owner));
  });

  const vAddress = validate({ body: SetAddressBody });
  r.put('/address', optionalAuth, vAddress, async (req, res) => {
    const owner = resolveCartOwner(req);
    const { address, addressId } = vAddress.get(req).body;
    res.json(view(await setAddress(ctx, owner, address, addressId), owner));
  });

  const vCoupon = validate({ body: SetCouponBody });
  r.put('/coupon', optionalAuth, vCoupon, async (req, res) => {
    const owner = resolveCartOwner(req);
    res.json(view(await setCoupon(ctx, owner, vCoupon.get(req).body.couponCode), owner));
  });

  const vMerge = validate({ body: MergeBody });
  r.post('/merge', requireAuth(), vMerge, async (req, res) => {
    res.json(await mergeGuestCart(ctx, req.auth!.userId, vMerge.get(req).body.guestToken));
  });

  const vPreview = validate({ body: PreviewBody });
  r.post('/preview', requireAuth(), vPreview, async (req, res) => {
    res.json(await previewCart(ctx, req.auth!.userId, vPreview.get(req).body));
  });

  app.use(BASE, r);
}

function openapi(o: import('@thali/service-kit').OpenApi): void {
  const tags = ['cart'];
  const guestOrUser = 'Signed-in users send a bearer token; guests send `X-Guest-Cart` (from POST /cart/guest).';
  const cartOk = { 200: { description: 'Cart', content: json(CartView) } };
  o.route({
    method: 'get',
    path: `${BASE}`,
    tags,
    summary: 'Get my cart (grouped by restaurant)',
    description: guestOrUser,
    security: 'bearer',
    request: { headers: GuestHeader },
    responses: cartOk,
    errors: ['NOT_FOUND'],
  });
  o.route({
    method: 'post',
    path: `${BASE}/guest`,
    tags,
    summary: 'Issue a guest cart token',
    description: 'Returns a 32-byte base64url token (stored hashed). Guest carts expire after 7 days.',
    rateLimited: true,
    responses: { 201: { description: 'Guest cart created', content: json(GuestTokenResponse) } },
  });
  o.route({
    method: 'post',
    path: `${BASE}/items`,
    tags,
    summary: 'Add an item (validated against the marketplace quote)',
    description: `${guestOrUser} Same item with identical selections merges quantity (max 20 per line); different selections create a new line.`,
    security: 'bearer',
    request: { headers: GuestHeader, body: { content: json(CartItemInput) } },
    responses: { 201: { description: 'Added', content: json(AddItemResponse) } },
    errors: ['NOT_FOUND', 'INVALID_SELECTION', 'ITEM_UNAVAILABLE', 'OUT_OF_STOCK'],
  });
  o.route({
    method: 'patch',
    path: `${BASE}/items/:lineId`,
    tags,
    summary: 'Change quantity / selections / note of a line',
    security: 'bearer',
    request: { headers: GuestHeader, params: LineIdParams, body: { content: json(CartItemUpdate) } },
    responses: cartOk,
    errors: ['NOT_FOUND', 'INVALID_SELECTION', 'ITEM_UNAVAILABLE', 'OUT_OF_STOCK'],
  });
  o.route({
    method: 'delete',
    path: `${BASE}/items/:lineId`,
    tags,
    summary: 'Remove a line',
    security: 'bearer',
    request: { headers: GuestHeader, params: LineIdParams },
    responses: cartOk,
    errors: ['NOT_FOUND'],
  });
  o.route({
    method: 'delete',
    path: `${BASE}`,
    tags,
    summary: 'Empty the cart',
    security: 'bearer',
    request: { headers: GuestHeader },
    responses: cartOk,
    errors: ['NOT_FOUND'],
  });
  o.route({
    method: 'put',
    path: `${BASE}/address`,
    tags,
    summary: 'Set the delivery address snapshot (addressId refers to a saved identity address)',
    security: 'bearer',
    request: { headers: GuestHeader, body: { content: json(SetAddressBody) } },
    responses: cartOk,
    errors: ['NOT_FOUND'],
  });
  o.route({
    method: 'put',
    path: `${BASE}/coupon`,
    tags,
    summary: 'Set or clear the coupon code (validated at preview/checkout)',
    security: 'bearer',
    request: { headers: GuestHeader, body: { content: json(SetCouponBody) } },
    responses: cartOk,
    errors: ['NOT_FOUND'],
  });
  o.route({
    method: 'post',
    path: `${BASE}/merge`,
    tags,
    summary: 'Merge a guest cart into my cart (idempotent)',
    security: 'bearer',
    request: { body: { content: json(MergeBody) } },
    responses: { 200: { description: 'Merge result', content: json(MergeResponse) } },
  });
  o.route({
    method: 'post',
    path: `${BASE}/preview`,
    tags,
    summary: 'Server quote + pricing for the cart (no reservation)',
    description: 'Problems (closed restaurant, unavailable item, …) and invalid coupons are reported in the body, not as errors.',
    security: 'bearer',
    request: { body: { content: json(PreviewBody) } },
    responses: { 200: { description: 'Preview', content: json(PreviewResponse) } },
    errors: ['CART_EMPTY', 'UPSTREAM_UNAVAILABLE'],
  });
}

export const cartModule: RouteModule = { name: 'cart', register, openapi };
