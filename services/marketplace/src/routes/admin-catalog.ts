/**
 * 🛡 Admin catalog CRUD: cuisines, banners, service areas (+ presign for catalog images). ADMIN + MFA;
 * every mutation is audited in the same transaction. (Coupons and membership plans: Task 9.)
 */
import type { Request } from 'express';
import { z } from 'zod';
import { DomainError, PaiseSchema } from '@thali/contracts';
import { auditEvent, isAllowedImageHost, requireAuth, validate, withTransaction } from '@thali/service-kit';
import { Types, type Model } from 'mongoose';
import type { AppContext, RouteModule } from '../context.js';
import { slugify } from '../domain/onboarding.js';
import { presignUpload } from '../domain/uploads.js';
import { BANNER_LINK_TYPES } from '../models/banner.js';
import { API, json, PresignView, UploadBody, userIdOf } from './common.js';

const A = `${API}/admin/marketplace`;
const admin = () => requireAuth({ roles: ['ADMIN'], mfa: true });
const IdParams = z.object({ id: z.string().min(1).max(64) });
const CatalogUploadKey = z.string().trim().regex(/^catalog\/[A-Za-z0-9/_.-]+$/, 'Use a key from the admin uploads presign (catalog/...)').max(300);
/** MKT-10: an uploaded catalog key, or an absolute https URL on an EXTERNAL_IMAGE_HOSTS host (host checked per request). */
const CatalogKey = z
  .union([CatalogUploadKey, z.url({ protocol: /^https$/ }).max(500)])
  .describe('catalog/... key from the uploads presign, or https URL on an allowlisted image host');

/** 400 VALIDATION_FAILED for an https image ref whose host is not allowlisted. */
function assertImageRef(ctx: AppContext, ref: unknown) {
  if (typeof ref !== 'string' || !/^https:\/\//i.test(ref)) return;
  const host = new URL(ref).hostname;
  if (!isAllowedImageHost(host, ctx.imageHosts)) {
    throw new DomainError('VALIDATION_FAILED', `Image host ${host} is not allowed`, undefined, { issues: [{ path: 'body.imageKey', message: 'Image host is not in EXTERNAL_IMAGE_HOSTS' }] });
  }
}

// ---- schemas ----
const CuisineCreate = z.object({
  name: z.string().trim().min(1).max(60),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(40).optional(),
  imageKey: CatalogKey.optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  active: z.boolean().optional(),
}).strict();
const CuisinePatch = CuisineCreate.partial();
const CuisineAdminView = z.object({ id: z.string(), name: z.string(), slug: z.string(), imageKey: z.string().nullable(), imageUrl: z.string().nullable(), sortOrder: z.number(), active: z.boolean() });

const BannerFields = z.object({
  title: z.string().trim().min(1).max(120),
  imageKey: CatalogKey,
  linkType: z.enum(BANNER_LINK_TYPES),
  linkValue: z.string().trim().min(1).max(120),
  activeFrom: z.coerce.date(),
  activeTo: z.coerce.date(),
  active: z.boolean().optional(),
  isDemo: z.boolean().optional(),
}).strict();
const BannerCreate = BannerFields.refine((b) => b.activeTo > b.activeFrom, { message: 'activeTo must be after activeFrom', path: ['activeTo'] });
const BannerPatch = BannerFields.partial();
const BannerAdminView = z.object({
  id: z.string(), title: z.string(), imageKey: z.string(), imageUrl: z.string().nullable(), linkType: z.string(), linkValue: z.string(),
  activeFrom: z.string(), activeTo: z.string(), active: z.boolean(), isDemo: z.boolean(),
});

const Position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const PolygonInput = z
  .object({ type: z.literal('Polygon'), coordinates: z.array(z.array(Position).min(3)).min(1).max(1) })
  .transform((p) => {
    // auto-close the ring
    const ring = [...p.coordinates[0]!];
    const [f, l] = [ring[0]!, ring[ring.length - 1]!];
    if (f[0] !== l[0] || f[1] !== l[1]) ring.push(f);
    return { type: 'Polygon' as const, coordinates: [ring] };
  })
  .refine((p) => p.coordinates[0]!.length >= 4, { message: 'A polygon ring needs at least 3 distinct points' })
  .describe('GeoJSON Polygon, [lng, lat] positions, single outer ring (auto-closed)');
const DeliveryFeeRule = z.object({ basePaise: PaiseSchema, baseKm: z.number().min(0).max(50), perKmPaise: PaiseSchema, maxPaise: PaiseSchema }).strict();
const AreaFields = {
  name: z.string().trim().min(1).max(80),
  polygon: PolygonInput,
  active: z.boolean().optional(),
  deliveryFee: DeliveryFeeRule,
  minOrderPaise: PaiseSchema,
};
const AreaCreate = z.object(AreaFields).strict();
const AreaPatch = z.object(AreaFields).partial().strict();
const AreaAdminView = z.object({
  id: z.string(), name: z.string(), polygon: z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(z.array(z.number()))) }), active: z.boolean(),
  deliveryFee: z.object({ basePaise: z.number(), baseKm: z.number(), perKmPaise: z.number(), maxPaise: z.number() }), minOrderPaise: z.number(),
});

// ---- generic CRUD ----
interface CrudSpec {
  name: string; // audit target type, e.g. 'cuisine'
  path: string;
  tag: string;
  create: z.ZodType;
  patch: z.ZodType;
  viewSchema: z.ZodType;
  model: (ctx: AppContext) => Model<any>;
  view: (ctx: AppContext, doc: any) => unknown;
  prepare?: (body: any, existing?: any) => Record<string, unknown>;
  label: (doc: any) => string;
}

const iso = (d: Date) => new Date(d).toISOString();

const specs: CrudSpec[] = [
  {
    name: 'cuisine', path: `${A}/cuisines`, tag: 'admin-catalog', create: CuisineCreate, patch: CuisinePatch, viewSchema: CuisineAdminView,
    model: (ctx) => ctx.models.Cuisine,
    view: (ctx, c) => ({ id: String(c._id), name: c.name, slug: c.slug, imageKey: c.imageKey ?? null, imageUrl: ctx.imageUrl(c.imageKey), sortOrder: c.sortOrder ?? 0, active: c.active !== false }),
    prepare: (b, existing) => (existing ? b : { ...b, slug: b.slug ?? slugify(b.name) }),
    label: (c) => c.name,
  },
  {
    name: 'banner', path: `${A}/banners`, tag: 'admin-catalog', create: BannerCreate, patch: BannerPatch, viewSchema: BannerAdminView,
    model: (ctx) => ctx.models.Banner,
    view: (ctx, b) => ({
      id: String(b._id), title: b.title, imageKey: b.imageKey, imageUrl: ctx.imageUrl(b.imageKey), linkType: b.linkType, linkValue: b.linkValue,
      activeFrom: iso(b.activeFrom), activeTo: iso(b.activeTo), active: b.active !== false, isDemo: !!b.isDemo,
    }),
    label: (b) => b.title,
  },
  {
    name: 'service_area', path: `${A}/service-areas`, tag: 'admin-catalog', create: AreaCreate, patch: AreaPatch, viewSchema: AreaAdminView,
    model: (ctx) => ctx.models.ServiceArea,
    view: (_ctx, a) => ({ id: String(a._id), name: a.name, polygon: a.polygon, active: a.active !== false, deliveryFee: a.deliveryFee, minOrderPaise: a.minOrderPaise ?? 0 }),
    label: (a) => a.name,
  },
];

function translateWriteError(e: unknown): never {
  const err = e as { code?: number; message?: string };
  if (err?.code === 11000) throw new DomainError('CONFLICT', 'An entry with the same unique key already exists');
  if (err?.code === 16755 || /geo keys|Loop|edges/i.test(err?.message ?? '')) {
    throw new DomainError('VALIDATION_FAILED', 'Invalid polygon geometry', undefined, { issues: [{ path: 'body.polygon', message: err.message }] });
  }
  throw e;
}

const oid = (id: string) => {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new DomainError('NOT_FOUND', 'Not found');
  return new Types.ObjectId(id);
};

async function audited<T>(ctx: AppContext, req: Request, spec: CrudSpec, verb: string, fn: (session: import('mongoose').ClientSession) => Promise<{ id: string; label: string; result: T }>) {
  return withTransaction(ctx.conn, async (session) => {
    const out = await fn(session);
    await auditEvent(ctx.conn, session, {
      service: 'marketplace', actorId: userIdOf(req), actorRole: 'ADMIN', action: `${spec.name}.${verb}`,
      targetType: spec.name, targetId: out.id, summary: `${verb} ${spec.name} "${out.label}"`, ip: req.ip,
    });
    return out.result;
  }).catch(translateWriteError);
}

export const adminCatalogRoutes: RouteModule = {
  name: 'admin-catalog',
  register(r, ctx) {
    for (const spec of specs) {
      const Model = spec.model(ctx);
      r.get(spec.path, admin(), async (_req, res) => {
        const rows = await Model.find({}).sort({ createdAt: -1 }).limit(500).lean();
        res.json({ items: rows.map((d) => spec.view(ctx, d)) });
      });
      const vCreate = validate({ body: spec.create });
      r.post(spec.path, admin(), vCreate, async (req, res) => {
        const body = vCreate.get(req).body as Record<string, unknown>;
        assertImageRef(ctx, body.imageKey);
        const result = await audited(ctx, req, spec, 'create', async (session) => {
          const [doc] = await Model.create([spec.prepare ? spec.prepare(body) : body], { session });
          return { id: String(doc._id), label: spec.label(doc), result: spec.view(ctx, doc.toObject()) };
        });
        res.status(201).json(result);
      });
      const vPatch = validate({ params: IdParams, body: spec.patch });
      r.patch(`${spec.path}/:id`, admin(), vPatch, async (req, res) => {
        const { params, body } = vPatch.get(req);
        assertImageRef(ctx, (body as Record<string, unknown>).imageKey);
        const result = await audited(ctx, req, spec, 'update', async (session) => {
          const doc = await Model.findById(oid(params.id)).session(session);
          if (!doc) throw new DomainError('NOT_FOUND', `${spec.name} not found`);
          doc.set(spec.prepare ? spec.prepare(body, doc) : (body as Record<string, unknown>));
          if (spec.name === 'banner' && doc.activeTo <= doc.activeFrom) throw new DomainError('VALIDATION_FAILED', 'activeTo must be after activeFrom');
          await doc.save({ session });
          return { id: String(doc._id), label: spec.label(doc), result: spec.view(ctx, doc.toObject()) };
        });
        res.json(result);
      });
      const vDel = validate({ params: IdParams });
      r.delete(`${spec.path}/:id`, admin(), vDel, async (req, res) => {
        const { params } = vDel.get(req);
        await audited(ctx, req, spec, 'delete', async (session) => {
          const doc = await Model.findOneAndDelete({ _id: oid(params.id) }, { session });
          if (!doc) throw new DomainError('NOT_FOUND', `${spec.name} not found`);
          return { id: String(doc._id), label: spec.label(doc), result: null };
        });
        res.status(204).end();
      });
    }

    const vUpload = validate({ body: UploadBody });
    r.post(`${A}/uploads`, admin(), vUpload, async (req, res) => {
      const body = vUpload.get(req).body;
      res.status(201).json(await presignUpload(ctx.storage, ctx.config, { prefix: 'catalog', purpose: 'IMAGE', ...body }));
    });
  },

  openapi(api) {
    const s = 'bearer' as const;
    for (const spec of specs) {
      const tags = [spec.tag];
      const errs = ['MFA_REQUIRED'] as const;
      api.route({ method: 'get', path: spec.path, tags, security: s, summary: `List ${spec.name}s`, responses: { 200: { description: 'List', content: json(z.object({ items: z.array(spec.viewSchema) })) } }, errors: [...errs] });
      api.route({ method: 'post', path: spec.path, tags, security: s, summary: `Create ${spec.name} (audited)`, request: { body: { content: json(spec.create) } }, responses: { 201: { description: 'Created', content: json(spec.viewSchema) } }, errors: ['CONFLICT', ...errs] });
      api.route({ method: 'patch', path: `${spec.path}/:id`, tags, security: s, summary: `Update ${spec.name} (audited)`, request: { params: IdParams, body: { content: json(spec.patch) } }, responses: { 200: { description: 'Updated', content: json(spec.viewSchema) } }, errors: ['NOT_FOUND', 'CONFLICT', ...errs] });
      api.route({ method: 'delete', path: `${spec.path}/:id`, tags, security: s, summary: `Delete ${spec.name} (audited)`, request: { params: IdParams }, responses: { 204: { description: 'Deleted' } }, errors: ['NOT_FOUND', ...errs] });
    }
    api.route({
      method: 'post', path: `${A}/uploads`, tags: ['admin-catalog'], security: s, summary: 'Presign a catalog image upload (image/jpeg|png|webp ≤ 2 MB, public bucket, key under catalog/)',
      request: { body: { content: json(UploadBody) } }, responses: { 201: { description: 'Presigned PUT', content: json(PresignView) } }, errors: ['FILE_INVALID', 'MFA_REQUIRED'],
    });
  },
};
