/**
 * 🍽 restaurant finance (ownership via marketplace GET /internal/restaurants/:id) and
 * 🛵 partner finance (always the caller's own userId — no account id is accepted from the client).
 */
import express, { type Request, type Router } from 'express';
import { DomainError, type LedgerAccountType } from '@thali/contracts';
import { PAGE_SORT, buildPage, cursorFilter, requireAuth, validate } from '@thali/service-kit';
import type { PaymentsContext } from '../context.js';
import { accountSummary, ledgerEntryView } from '../domain/ledger.js';
import { payoutView } from '../domain/payouts.js';
import { PageQuery, RestaurantParams } from '../schemas.js';

export async function listLedger(ctx: PaymentsContext, accountType: LedgerAccountType, accountId: string, q: { limit: number; cursor?: string }) {
  const docs = await ctx.models.LedgerEntry.find({ accountType, accountId, ...cursorFilter(q.cursor) })
    .sort(PAGE_SORT)
    .limit(q.limit + 1)
    .lean();
  return buildPage(docs, q.limit, ledgerEntryView);
}

export async function listAccountPayouts(ctx: PaymentsContext, accountType: 'RESTAURANT' | 'PARTNER', accountId: string, q: { limit: number; cursor?: string }) {
  const docs = await ctx.models.Payout.find({ accountType, accountId, ...cursorFilter(q.cursor) })
    .sort(PAGE_SORT)
    .limit(q.limit + 1)
    .lean();
  return buildPage(docs, q.limit, payoutView);
}

export function financeRouter(ctx: PaymentsContext): Router {
  const r = express.Router();
  const owner = requireAuth({ roles: ['RESTAURANT_OWNER'] });
  const partner = requireAuth({ roles: ['DELIVERY_PARTNER'] });
  const vRest = validate({ params: RestaurantParams, query: PageQuery });
  const vPage = validate({ query: PageQuery });

  const ownedRestaurant = async (req: Request): Promise<string> => {
    const { params } = vRest.get(req);
    const restaurant = await ctx.marketplace.getRestaurant(params.restaurantId);
    if (!restaurant) throw new DomainError('NOT_FOUND', 'Restaurant not found');
    if (restaurant.ownerUserId !== req.auth!.userId) throw new DomainError('FORBIDDEN', 'You do not own this restaurant');
    return params.restaurantId;
  };

  r.get('/api/v1/finance/restaurants/:restaurantId/summary', owner, vRest, async (req, res) => {
    res.json(await accountSummary(ctx, 'RESTAURANT', await ownedRestaurant(req)));
  });
  r.get('/api/v1/finance/restaurants/:restaurantId/ledger', owner, vRest, async (req, res) => {
    const id = await ownedRestaurant(req);
    res.json(await listLedger(ctx, 'RESTAURANT', id, vRest.get(req).query));
  });
  r.get('/api/v1/finance/restaurants/:restaurantId/payouts', owner, vRest, async (req, res) => {
    const id = await ownedRestaurant(req);
    res.json(await listAccountPayouts(ctx, 'RESTAURANT', id, vRest.get(req).query));
  });

  r.get('/api/v1/finance/partner/summary', partner, async (req, res) => {
    res.json(await accountSummary(ctx, 'PARTNER', req.auth!.userId));
  });
  r.get('/api/v1/finance/partner/ledger', partner, vPage, async (req, res) => {
    res.json(await listLedger(ctx, 'PARTNER', req.auth!.userId, vPage.get(req).query));
  });
  r.get('/api/v1/finance/partner/payouts', partner, vPage, async (req, res) => {
    res.json(await listAccountPayouts(ctx, 'PARTNER', req.auth!.userId, vPage.get(req).query));
  });
  return r;
}
