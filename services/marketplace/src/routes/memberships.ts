/**
 * Memberships (customer):
 *   🔓 GET  /api/v1/memberships/plans     active plans with transparent terms
 *   👤 GET  /api/v1/memberships/me        current membership + purchase history
 *   👤 POST /api/v1/memberships/purchase  {planId}, Idempotency-Key required → 201 {membership, payment}
 */
import { z } from 'zod';
import { ObjectIdSchema } from '@thali/contracts';
import { idempotency, rateLimit, requireAuth, validate } from '@thali/service-kit';
import type { RouteModule } from '../context.js';
import { PaymentIntentSchema } from '../clients/payments.js';
import { listActivePlans, myMemberships, purchaseMembership } from '../domain/memberships.js';
import { API, json, userIdOf } from './common.js';

export const PlanBenefitsView = z
  .object({
    freeDeliveryMinOrderPaise: z.number().int(),
    freeDeliveriesPerPeriod: z.number().int(),
    extraDiscountBps: z.number().int(),
    extraDiscountCapPaise: z.number().int(),
  })
  .meta({ id: 'MembershipBenefits' });

export const PlanView = z
  .object({ id: z.string(), name: z.string(), pricePaise: z.number().int(), durationDays: z.number().int(), benefits: PlanBenefitsView, terms: z.string().describe('Markdown'), active: z.boolean() })
  .meta({ id: 'MembershipPlan' });

export const MembershipView = z
  .object({
    id: z.string(),
    planId: z.string(),
    plan: z.object({ name: z.string(), pricePaise: z.number().int(), durationDays: z.number().int(), benefits: PlanBenefitsView, terms: z.string() }),
    status: z.enum(['PENDING_PAYMENT', 'ACTIVE', 'EXPIRED', 'CANCELLED']),
    startsAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    paymentIntentId: z.string().nullable(),
    freeDeliveriesUsed: z.number().int(),
    freeDeliveriesRemaining: z.number().int(),
    createdAt: z.string().nullable(),
  })
  .meta({ id: 'Membership' });

const PurchaseBody = z.object({ planId: ObjectIdSchema }).strict();
const PurchaseResponse = z.object({ membership: MembershipView, payment: PaymentIntentSchema }).meta({ id: 'MembershipPurchase' });

export const membershipRoutes: RouteModule = {
  name: 'memberships',
  register(r, ctx) {
    r.get(`${API}/memberships/plans`, async (_req, res) => {
      res.json({ items: await listActivePlans(ctx) });
    });
    r.get(`${API}/memberships/me`, requireAuth(), async (req, res) => {
      res.json(await myMemberships(ctx, userIdOf(req)));
    });
    const vPurchase = validate({ body: PurchaseBody });
    r.post(
      `${API}/memberships/purchase`,
      requireAuth(),
      rateLimit({ redis: ctx.redis, name: 'membership-purchase', keyFn: (req) => req.auth?.userId ?? null, points: 10, durationSec: 60 }),
      idempotency({ scope: 'membership-purchase', conn: ctx.conn }),
      vPurchase,
      async (req, res) => {
        res.status(201).json(await purchaseMembership(ctx, userIdOf(req), vPurchase.get(req).body.planId));
      },
    );
  },
  openapi(api) {
    const tags = ['memberships'];
    api.route({ method: 'get', path: `${API}/memberships/plans`, tags, summary: 'Active membership plans (prepaid; no auto-renewal)', responses: { 200: { description: 'Plans', content: json(z.object({ items: z.array(PlanView) })) } } });
    api.route({
      method: 'get',
      path: `${API}/memberships/me`,
      tags,
      security: 'bearer',
      summary: 'My current membership and purchase history',
      responses: { 200: { description: 'Memberships', content: json(z.object({ current: MembershipView.nullable(), history: z.array(MembershipView) })) } },
    });
    api.route({
      method: 'post',
      path: `${API}/memberships/purchase`,
      tags,
      security: 'bearer',
      summary: 'Start a membership purchase (Idempotency-Key required). Activates only when payment.captured arrives.',
      request: { body: { content: json(PurchaseBody) }, headers: z.object({ 'idempotency-key': z.string().min(8).max(128) }) },
      responses: { 201: { description: 'Pending membership + payment intent', content: json(PurchaseResponse) } },
      errors: ['NOT_FOUND', 'CONFLICT', 'IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_IN_PROGRESS', 'RATE_LIMITED', 'PAYMENT_PROVIDER_UNAVAILABLE'],
    });
  },
};
