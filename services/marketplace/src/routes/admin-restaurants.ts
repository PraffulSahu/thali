/** 🛡 Admin restaurant review: list/detail, approve/reject/suspend/reinstate, KYC documents. ADMIN + MFA, audited. */
import type { Request } from 'express';
import { z } from 'zod';
import { DomainError, RestaurantStatusSchema, type RestaurantStatus } from '@thali/contracts';
import { auditEvent, buildPage, cursorFilter, PAGE_SORT, requireAuth, validate, withTransaction } from '@thali/service-kit';
import { Types } from 'mongoose';
import type { AppContext, RouteModule } from '../context.js';
import { restaurantView, type RestaurantLean } from '../domain/restaurant-view.js';
import { transitionRestaurant } from '../domain/transitions.js';
import { API, json, OptionalReasonBody, ReasonBody, RestaurantIdParams, RestaurantView, userIdOf } from './common.js';

const P = `${API}/admin/marketplace/restaurants`;
const admin = () => requireAuth({ roles: ['ADMIN'], mfa: true });

const ListQuery = z.object({
  status: RestaurantStatusSchema.optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});
const DocParams = RestaurantIdParams.extend({ docId: z.string().min(1).max(64) });

type Action = 'approve' | 'reject' | 'suspend' | 'reinstate';
const ACTIONS: Record<Action, { from: RestaurantStatus; to: RestaurantStatus; reasonRequired: boolean }> = {
  approve: { from: 'APPROVAL_PENDING', to: 'APPROVED', reasonRequired: false },
  reject: { from: 'APPROVAL_PENDING', to: 'REJECTED', reasonRequired: true },
  suspend: { from: 'APPROVED', to: 'SUSPENDED', reasonRequired: true },
  reinstate: { from: 'SUSPENDED', to: 'APPROVED', reasonRequired: false },
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const notFound = () => new DomainError('NOT_FOUND', 'Restaurant not found');
const oid = (id: string) => {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw notFound();
  return new Types.ObjectId(id);
};

async function act(ctx: AppContext, req: Request, id: string, action: Action, reason?: string) {
  const rule = ACTIONS[action];
  const adminId = userIdOf(req);
  return withTransaction(ctx.conn, async (session) => {
    const doc = await ctx.models.Restaurant.findById(oid(id)).session(session);
    if (!doc) throw notFound();
    const from = doc.status as RestaurantStatus;
    // the action names a specific edge; the shared table enforces the email gate (VERIFICATION_PENDING ↛ APPROVED)
    if (from !== rule.from) {
      throw new DomainError('RESTAURANT_INVALID_TRANSITION', `Cannot ${action} a restaurant in status ${from}`, undefined, { from, to: rule.to, actor: 'ADMIN' });
    }
    if (action === 'approve' && !doc.emailVerifiedAt) {
      throw new DomainError('RESTAURANT_INVALID_TRANSITION', 'Business email is not verified', undefined, { from, to: rule.to, actor: 'ADMIN' });
    }
    await transitionRestaurant(ctx, session, doc, rule.to, { actor: 'ADMIN', actorId: adminId, reason });
    await doc.save({ session });
    await auditEvent(ctx.conn, session, {
      service: 'marketplace',
      actorId: adminId,
      actorRole: 'ADMIN',
      action: `restaurant.${action}`,
      targetType: 'restaurant',
      targetId: String(doc._id),
      summary: `${action} "${doc.name}" (${from} → ${rule.to})${reason ? `: ${reason}` : ''}`,
      ip: req.ip,
    });
    return doc;
  });
}

export const adminRestaurantRoutes: RouteModule = {
  name: 'admin-restaurants',
  register(r, ctx) {
    const view = (d: Parameters<typeof restaurantView>[0]) => restaurantView(d, ctx.storage);

    const vList = validate({ query: ListQuery });
    r.get(P, admin(), vList, async (req, res) => {
      const { status, q, limit, cursor } = vList.get(req).query;
      const filter: Record<string, unknown> = { ...cursorFilter(cursor) };
      if (status) filter.status = status;
      if (q) filter.name = new RegExp(escapeRegex(q), 'i');
      const docs = await ctx.models.Restaurant.find(filter).sort(PAGE_SORT).limit(limit + 1).lean<(RestaurantLean & { _id: Types.ObjectId; createdAt: Date })[]>();
      res.json(buildPage(docs, limit, view));
    });

    const vId = validate({ params: RestaurantIdParams });
    r.get(`${P}/:id`, admin(), vId, async (req, res) => {
      const doc = await ctx.models.Restaurant.findById(oid(vId.get(req).params.id));
      if (!doc) throw notFound();
      res.json(view(doc));
    });

    for (const action of Object.keys(ACTIONS) as Action[]) {
      const v = validate({ params: RestaurantIdParams, body: ACTIONS[action].reasonRequired ? ReasonBody : OptionalReasonBody });
      r.post(`${P}/:id/${action}`, admin(), v, async (req, res) => {
        const { params, body } = v.get(req);
        res.json(view(await act(ctx, req, params.id, action, body.reason)));
      });
    }

    const vDoc = validate({ params: DocParams });
    r.get(`${P}/:id/documents/:docId/url`, admin(), vDoc, async (req, res) => {
      const { params } = vDoc.get(req);
      const doc = await ctx.models.Restaurant.findById(oid(params.id)).lean<RestaurantLean>();
      const d = doc?.documents?.find((x) => String((x as { _id?: unknown })._id) === params.docId);
      if (!doc || !d) throw new DomainError('NOT_FOUND', 'Document not found');
      const signed = await ctx.storage.presignGet({ bucket: ctx.config.S3_PRIVATE_BUCKET, key: d.key, expiresSec: 300 });
      await withTransaction(ctx.conn, (session) =>
        auditEvent(ctx.conn, session, {
          service: 'marketplace', actorId: userIdOf(req), actorRole: 'ADMIN', action: 'restaurant.document_viewed',
          targetType: 'restaurant', targetId: params.id, summary: `Viewed ${d.type} document`, ip: req.ip,
        }),
      );
      res.json(signed);
    });

    r.post(`${P}/:id/documents/:docId/verify`, admin(), vDoc, async (req, res) => {
      const { params } = vDoc.get(req);
      const out = await withTransaction(ctx.conn, async (session) => {
        const doc = await ctx.models.Restaurant.findById(oid(params.id)).session(session);
        const d = doc?.documents?.find((x) => String(x._id) === params.docId);
        if (!doc || !d) throw new DomainError('NOT_FOUND', 'Document not found');
        d.verified = true;
        await doc.save({ session });
        await auditEvent(ctx.conn, session, {
          service: 'marketplace', actorId: userIdOf(req), actorRole: 'ADMIN', action: 'restaurant.document_verified',
          targetType: 'restaurant', targetId: params.id, summary: `Verified ${d.type} document`, ip: req.ip,
        });
        return { id: String(d._id), type: d.type, key: d.key, verified: true, uploadedAt: d.uploadedAt?.toISOString() ?? null };
      });
      res.json(out);
    });
  },

  openapi(api) {
    const tags = ['admin-restaurants'];
    const s = 'bearer' as const;
    api.route({
      method: 'get', path: P, tags, security: s, summary: 'List restaurants (filter by status, name)', request: { query: ListQuery },
      responses: { 200: { description: 'Page', content: json(z.object({ items: z.array(RestaurantView), nextCursor: z.string().nullable() })) } }, errors: ['MFA_REQUIRED'],
    });
    api.route({ method: 'get', path: `${P}/:id`, tags, security: s, summary: 'Restaurant detail (documents, status history)', request: { params: RestaurantIdParams }, responses: { 200: { description: 'Restaurant', content: json(RestaurantView) } }, errors: ['NOT_FOUND', 'MFA_REQUIRED'] });
    for (const [action, rule] of Object.entries(ACTIONS)) {
      api.route({
        method: 'post', path: `${P}/:id/${action}`, tags, security: s,
        summary: `${action}: ${rule.from} → ${rule.to}${rule.reasonRequired ? ' (reason required)' : ''}. Emits restaurant.status_changed + audit.recorded.`,
        request: { params: RestaurantIdParams, body: { content: json(rule.reasonRequired ? ReasonBody : OptionalReasonBody) } },
        responses: { 200: { description: 'Updated restaurant', content: json(RestaurantView) } },
        errors: ['NOT_FOUND', 'RESTAURANT_INVALID_TRANSITION', 'MFA_REQUIRED', 'CONCURRENT_MODIFICATION'],
      });
    }
    api.route({
      method: 'get', path: `${P}/:id/documents/:docId/url`, tags, security: s, summary: 'Short-lived (5 min) signed URL for a KYC document (audited)',
      request: { params: DocParams }, responses: { 200: { description: 'Signed URL', content: json(z.object({ url: z.string(), expiresAt: z.string() })) } }, errors: ['NOT_FOUND', 'MFA_REQUIRED'],
    });
    api.route({
      method: 'post', path: `${P}/:id/documents/:docId/verify`, tags, security: s, summary: 'Mark a KYC document as verified (audited)',
      request: { params: DocParams },
      responses: { 200: { description: 'Document', content: json(z.object({ id: z.string(), type: z.string(), key: z.string(), verified: z.boolean(), uploadedAt: z.string().nullable() })) } },
      errors: ['NOT_FOUND', 'MFA_REQUIRED'],
    });
  },
};
