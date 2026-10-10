/**
 * 🛡 Admin promotions (ADMIN + MFA, every mutation audited in the same transaction):
 *   CRUD /api/v1/admin/marketplace/coupons  (code immutable; delete only without redemptions)
 *   CRUD /api/v1/admin/marketplace/plans    (delete only without memberships; prefer active:false)
 *   GET  /api/v1/admin/marketplace/overview (counts from stored records)
 * `usedCount`/`heldCount` are never writable here — only reservations/commerce events change them.
 */
import type { Request } from 'express';
import { Types, type ClientSession } from 'mongoose';
import { z } from 'zod';
import { DomainError, PaiseSchema } from '@thali/contracts';
import { auditEvent, requireAuth, validate, withTransaction } from '@thali/service-kit';
import type { AppContext, RouteModule } from '../context.js';
import type { CouponLean } from '../domain/coupons.js';
import { adminOverview } from '../domain/dashboard.js';
import { planView, type PlanLean } from '../domain/memberships.js';
import { API, json, userIdOf } from './common.js';
import { PlanView } from './memberships.js';

const A = `${API}/admin/marketplace`;
const admin = () => requireAuth({ roles: ['ADMIN'], mfa: true });
const IdParams = z.object({ id: z.string().min(1).max(64) });

// ---- coupons ----
// Field definitions carry NO defaults: Zod 4 still applies `.default()` inside `.partial()`, so a PATCH
// schema derived from defaulted fields would silently reset active/limits. Defaults live on create only.
const couponFieldDefs = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/, '3–30 chars: A-Z, 0-9, _ or -'),
  description: z.string().trim().max(300),
  type: z.enum(['FLAT', 'PERCENT']),
  valuePaise: PaiseSchema,
  valueBps: z.number().int().min(1).max(10000),
  maxDiscountPaise: PaiseSchema.nullable(),
  minOrderPaise: PaiseSchema,
  validFrom: z.coerce.date(),
  validTo: z.coerce.date(),
  totalLimit: z.number().int().min(1).nullable().describe('null = unlimited'),
  perUserLimit: z.number().int().min(1),
  active: z.boolean(),
  firstOrderOnly: z.boolean(),
};
const CouponFields = z
  .object({
    ...couponFieldDefs,
    description: couponFieldDefs.description.default(''),
    valuePaise: couponFieldDefs.valuePaise.optional(),
    valueBps: couponFieldDefs.valueBps.optional(),
    maxDiscountPaise: couponFieldDefs.maxDiscountPaise.optional(),
    minOrderPaise: couponFieldDefs.minOrderPaise.default(0),
    totalLimit: couponFieldDefs.totalLimit.default(null),
    perUserLimit: couponFieldDefs.perUserLimit.default(1),
    active: couponFieldDefs.active.default(true),
    firstOrderOnly: couponFieldDefs.firstOrderOnly.default(false),
  })
  .strict();

type CouponInput = Partial<z.output<typeof CouponFields>>;
function couponRules(c: CouponInput, path = 'body') {
  const issues: { path: string; message: string }[] = [];
  if (c.type === 'FLAT' && !(c.valuePaise && c.valuePaise > 0)) issues.push({ path: `${path}.valuePaise`, message: 'FLAT coupons need valuePaise > 0' });
  if (c.type === 'PERCENT' && !c.valueBps) issues.push({ path: `${path}.valueBps`, message: 'PERCENT coupons need valueBps (1–10000)' });
  if (c.validFrom && c.validTo && c.validTo <= c.validFrom) issues.push({ path: `${path}.validTo`, message: 'validTo must be after validFrom' });
  if (issues.length) throw new DomainError('VALIDATION_FAILED', issues[0]!.message, undefined, { issues });
}
const CouponCreate = CouponFields;
const CouponPatch = z.object(couponFieldDefs).omit({ code: true }).partial().strict();

export const CouponAdminView = z
  .object({
    id: z.string(),
    code: z.string(),
    description: z.string(),
    type: z.enum(['FLAT', 'PERCENT']),
    valuePaise: z.number().int().nullable(),
    valueBps: z.number().int().nullable(),
    maxDiscountPaise: z.number().int().nullable(),
    minOrderPaise: z.number().int(),
    validFrom: z.string(),
    validTo: z.string(),
    totalLimit: z.number().int().nullable(),
    perUserLimit: z.number().int().nullable(),
    usedCount: z.number().int(),
    heldCount: z.number().int(),
    active: z.boolean(),
    firstOrderOnly: z.boolean(),
  })
  .meta({ id: 'AdminCoupon' });

function couponAdminView(c: CouponLean) {
  return {
    id: String(c._id),
    code: c.code,
    description: c.description ?? '',
    type: c.type,
    valuePaise: c.valuePaise ?? null,
    valueBps: c.valueBps ?? null,
    maxDiscountPaise: c.maxDiscountPaise ?? null,
    minOrderPaise: c.minOrderPaise ?? 0,
    validFrom: new Date(c.validFrom).toISOString(),
    validTo: new Date(c.validTo).toISOString(),
    totalLimit: c.totalLimit ?? null,
    perUserLimit: c.perUserLimit ?? null,
    usedCount: c.usedCount ?? 0,
    heldCount: c.heldCount ?? 0,
    active: c.active !== false,
    firstOrderOnly: !!c.firstOrderOnly,
  };
}

// ---- plans ---- (defaults on create only; see the coupon note above)
const planFieldDefs = {
  name: z.string().trim().min(1).max(80),
  pricePaise: PaiseSchema,
  durationDays: z.number().int().min(1).max(366),
  benefits: z
    .object({
      freeDeliveryMinOrderPaise: PaiseSchema,
      freeDeliveriesPerPeriod: z.number().int().min(0).max(1000),
      extraDiscountBps: z.number().int().min(0).max(10000),
      extraDiscountCapPaise: PaiseSchema,
    })
    .strict(),
  terms: z.string().trim().min(1).max(20000),
  active: z.boolean(),
};
const PlanFields = z.object({ ...planFieldDefs, active: planFieldDefs.active.default(true) }).strict();
const PlanPatch = z.object(planFieldDefs).partial().strict();

// ---- overview ----
const OverviewView = z
  .object({
    generatedAt: z.string(),
    restaurants: z.object({ total: z.number().int(), byStatus: z.record(z.string(), z.number().int()), pendingApproval: z.number().int(), pendingVerification: z.number().int() }),
    coupons: z.object({ total: z.number().int(), active: z.number().int(), redeemed: z.number().int(), redeemedDiscountPaise: z.number().int(), held: z.number().int() }),
    memberships: z.object({ active: z.number().int(), pendingPayment: z.number().int(), byStatus: z.record(z.string(), z.number().int()) }),
    reservations: z.object({ held: z.number().int() }),
    ratings: z.object({ total: z.number().int() }),
    menu: z.object({ items: z.number().int() }),
  })
  .meta({ id: 'MarketplaceOverview' });

// ---- helpers ----
const oid = (id: string) => {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new DomainError('NOT_FOUND', 'Not found');
  return new Types.ObjectId(id);
};

async function audited<T>(ctx: AppContext, req: Request, target: string, verb: string, fn: (s: ClientSession) => Promise<{ id: string; label: string; result: T }>) {
  try {
    return await withTransaction(ctx.conn, async (session) => {
      const out = await fn(session);
      await auditEvent(ctx.conn, session, {
        service: 'marketplace',
        actorId: userIdOf(req),
        actorRole: 'ADMIN',
        action: `${target}.${verb}`,
        targetType: target,
        targetId: out.id,
        summary: `${verb} ${target} "${out.label}"`,
        ip: req.ip,
      });
      return out.result;
    });
  } catch (e) {
    if ((e as { code?: number })?.code === 11000) throw new DomainError('CONFLICT', 'An entry with the same code already exists');
    throw e;
  }
}

export const adminPromotionRoutes: RouteModule = {
  name: 'admin-promotions',
  register(r, ctx) {
    // coupons
    r.get(`${A}/coupons`, admin(), async (_req, res) => {
      const rows = await ctx.models.Coupon.find({}).sort({ createdAt: -1 }).limit(500).lean<CouponLean[]>();
      res.json({ items: rows.map(couponAdminView) });
    });
    const vCreate = validate({ body: CouponCreate });
    r.post(`${A}/coupons`, admin(), vCreate, async (req, res) => {
      const body = vCreate.get(req).body;
      couponRules(body);
      const result = await audited(ctx, req, 'coupon', 'create', async (session) => {
        const [doc] = await ctx.models.Coupon.create([{ ...body, usedCount: 0, heldCount: 0 }], { session });
        return { id: String(doc!._id), label: doc!.code, result: couponAdminView(doc!.toObject() as CouponLean) };
      });
      res.status(201).json(result);
    });
    const vPatch = validate({ params: IdParams, body: CouponPatch });
    r.patch(`${A}/coupons/:id`, admin(), vPatch, async (req, res) => {
      const { params, body } = vPatch.get(req);
      const result = await audited(ctx, req, 'coupon', 'update', async (session) => {
        const doc = await ctx.models.Coupon.findById(oid(params.id)).session(session);
        if (!doc) throw new DomainError('NOT_FOUND', 'Coupon not found');
        doc.set(body);
        couponRules(doc.toObject() as CouponInput);
        await doc.save({ session });
        return { id: String(doc._id), label: doc.code, result: couponAdminView(doc.toObject() as CouponLean) };
      });
      res.json(result);
    });
    const vDel = validate({ params: IdParams });
    r.delete(`${A}/coupons/:id`, admin(), vDel, async (req, res) => {
      const id = oid(vDel.get(req).params.id);
      await audited(ctx, req, 'coupon', 'delete', async (session) => {
        if (await ctx.models.CouponRedemption.exists({ couponId: id }).session(session)) {
          throw new DomainError('CONFLICT', 'This coupon has redemptions; deactivate it instead');
        }
        const doc = await ctx.models.Coupon.findOneAndDelete({ _id: id }, { session });
        if (!doc) throw new DomainError('NOT_FOUND', 'Coupon not found');
        return { id: String(doc._id), label: doc.code, result: null };
      });
      res.status(204).end();
    });

    // plans
    r.get(`${A}/plans`, admin(), async (_req, res) => {
      const rows = await ctx.models.MembershipPlan.find({}).sort({ createdAt: -1 }).limit(200).lean<PlanLean[]>();
      res.json({ items: rows.map(planView) });
    });
    const vPlan = validate({ body: PlanFields });
    r.post(`${A}/plans`, admin(), vPlan, async (req, res) => {
      const body = vPlan.get(req).body;
      const result = await audited(ctx, req, 'plan', 'create', async (session) => {
        const [doc] = await ctx.models.MembershipPlan.create([body], { session });
        return { id: String(doc!._id), label: doc!.name, result: planView(doc!.toObject() as PlanLean) };
      });
      res.status(201).json(result);
    });
    const vPlanPatch = validate({ params: IdParams, body: PlanPatch });
    r.patch(`${A}/plans/:id`, admin(), vPlanPatch, async (req, res) => {
      const { params, body } = vPlanPatch.get(req);
      const result = await audited(ctx, req, 'plan', 'update', async (session) => {
        const doc = await ctx.models.MembershipPlan.findById(oid(params.id)).session(session);
        if (!doc) throw new DomainError('NOT_FOUND', 'Plan not found');
        doc.set(body);
        await doc.save({ session });
        return { id: String(doc._id), label: doc.name, result: planView(doc.toObject() as PlanLean) };
      });
      res.json(result);
    });
    const vPlanDel = validate({ params: IdParams });
    r.delete(`${A}/plans/:id`, admin(), vPlanDel, async (req, res) => {
      const id = oid(vPlanDel.get(req).params.id);
      await audited(ctx, req, 'plan', 'delete', async (session) => {
        if (await ctx.models.Membership.exists({ planId: id }).session(session)) throw new DomainError('CONFLICT', 'This plan has memberships; deactivate it instead');
        const doc = await ctx.models.MembershipPlan.findOneAndDelete({ _id: id }, { session });
        if (!doc) throw new DomainError('NOT_FOUND', 'Plan not found');
        return { id: String(doc._id), label: doc.name, result: null };
      });
      res.status(204).end();
    });

    // overview
    r.get(`${A}/overview`, admin(), async (_req, res) => {
      res.json(await adminOverview(ctx));
    });
  },
  openapi(api) {
    const s = 'bearer' as const;
    const mfa = ['MFA_REQUIRED'] as const;
    const crud = (name: string, path: string, create: z.ZodType, patch: z.ZodType, view: z.ZodType, delNote: string) => {
      const tags = ['admin-promotions'];
      api.route({ method: 'get', path, tags, security: s, summary: `List ${name}s`, responses: { 200: { description: 'List', content: json(z.object({ items: z.array(view) })) } }, errors: [...mfa] });
      api.route({ method: 'post', path, tags, security: s, summary: `Create ${name} (audited)`, request: { body: { content: json(create) } }, responses: { 201: { description: 'Created', content: json(view) } }, errors: ['CONFLICT', ...mfa] });
      api.route({ method: 'patch', path: `${path}/:id`, tags, security: s, summary: `Update ${name} (audited)`, request: { params: IdParams, body: { content: json(patch) } }, responses: { 200: { description: 'Updated', content: json(view) } }, errors: ['NOT_FOUND', ...mfa] });
      api.route({ method: 'delete', path: `${path}/:id`, tags, security: s, summary: `Delete ${name} (audited; ${delNote})`, request: { params: IdParams }, responses: { 204: { description: 'Deleted' } }, errors: ['NOT_FOUND', 'CONFLICT', ...mfa] });
    };
    crud('coupon', `${A}/coupons`, CouponCreate, CouponPatch, CouponAdminView, '409 if it has redemptions');
    crud('membership plan', `${A}/plans`, PlanFields, PlanPatch, PlanView, '409 if it has memberships');
    api.route({ method: 'get', path: `${A}/overview`, tags: ['admin-promotions'], security: s, summary: 'Marketplace overview metrics (from stored records)', responses: { 200: { description: 'Overview', content: json(OverviewView) } }, errors: [...mfa] });
  },
};
