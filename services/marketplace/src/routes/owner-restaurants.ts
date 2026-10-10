/** 🍽 Owner restaurant onboarding & store controls (LLD 10 marketplace, PRD R-1/R-2/R-4/R-8). */
import { z } from 'zod';
import { GeoPointSchema, HoursSchema, PaiseSchema, PhoneSchema, RestaurantAddressSchema } from '@thali/contracts';
import { requireAuth, validate } from '@thali/service-kit';
import type { RouteModule } from '../context.js';
import { resendVerification } from '../domain/email-verification.js';
import {
  attachDocument,
  createRestaurant,
  findOwned,
  restaurantPrefix,
  setHours,
  setPause,
  setSettlement,
  submitRestaurant,
  updateRestaurant,
} from '../domain/onboarding.js';
import { restaurantView } from '../domain/restaurant-view.js';
import { presignUpload } from '../domain/uploads.js';
import { API, json, PresignView, RestaurantIdParams, RestaurantView, UploadBody, userIdOf } from './common.js';

const CuisineSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase cuisine slugs, e.g. north-indian')
  .max(40);

const ImageKey = z.string().trim().min(1).max(300).nullable().optional();

export const ProfileBody = z
  .object({
    businessName: z.string().trim().min(1).max(120).optional(),
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().min(1).max(1000).optional(),
    cuisines: z.array(CuisineSlug).min(1).max(10).optional(),
    phone: PhoneSchema.optional(),
    businessEmail: z.string().trim().toLowerCase().pipe(z.email()).optional(),
    address: RestaurantAddressSchema.optional(),
    location: GeoPointSchema.optional(),
    deliveryRadiusKm: z.number().min(0.5).max(15).optional(),
    hours: HoursSchema.optional(),
    packagingFeePaise: PaiseSchema.optional(),
    avgPrepMinutes: z.number().int().min(5).max(120).optional(),
    images: z.object({ cover: ImageKey, logo: ImageKey }).strict().optional(),
  })
  .strict()
  .meta({ id: 'RestaurantProfilePatch' });

const CreateBody = ProfileBody.extend({ name: z.string().trim().min(1).max(80) }).meta({ id: 'RestaurantCreate' });

const SettlementBody = z
  .object({
    accountHolder: z.string().trim().min(2).max(120),
    accountNumber: z.string().regex(/^\d{9,18}$/, 'Account number must be 9–18 digits'),
    ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC'),
  })
  .meta({ id: 'SettlementInput' });
const SettlementView = z.object({ accountHolder: z.string(), ifsc: z.string(), last4: z.string() }).meta({ id: 'SettlementView' });

const HoursBody = z.object({ hours: HoursSchema });
const PauseBody = z.object({ minutes: z.number().int().min(1).max(10080) });
const OwnerUploadBody = UploadBody.extend({ purpose: z.enum(['IMAGE', 'DOCUMENT']) });
export const DOCUMENT_TYPES = ['FSSAI', 'GST', 'PAN', 'TRADE_LICENSE', 'OTHER'] as const;
const DocumentBody = z.object({ type: z.enum(DOCUMENT_TYPES), key: z.string().min(1).max(300) });
const DocumentView = z.object({ id: z.string(), type: z.string(), key: z.string(), verified: z.boolean(), uploadedAt: z.string().nullable() });

const owner = () => requireAuth({ roles: ['RESTAURANT_OWNER'] });
const P = `${API}/owner/restaurants`;

export const ownerRestaurantRoutes: RouteModule = {
  name: 'owner-restaurants',
  register(r, ctx) {
    const view = (d: Parameters<typeof restaurantView>[0]) => restaurantView(d, ctx.storage);
    const vId = validate({ params: RestaurantIdParams });

    const vCreate = validate({ body: CreateBody });
    r.post(P, requireAuth(), vCreate, async (req, res) => {
      const doc = await createRestaurant(ctx, userIdOf(req), vCreate.get(req).body);
      res.status(201).json({ restaurant: view(doc), roleGranted: true });
    });

    r.get(P, owner(), async (req, res) => {
      const docs = await ctx.models.Restaurant.find({ ownerUserId: userIdOf(req) }).sort({ createdAt: -1, _id: -1 }).limit(100);
      res.json({ items: docs.map(view) });
    });

    r.get(`${P}/:id`, owner(), vId, async (req, res) => {
      res.json(view(await findOwned(ctx, vId.get(req).params.id, userIdOf(req))));
    });

    const vPatch = validate({ params: RestaurantIdParams, body: ProfileBody });
    r.patch(`${P}/:id`, owner(), vPatch, async (req, res) => {
      const { params, body } = vPatch.get(req);
      res.json(view(await updateRestaurant(ctx, params.id, userIdOf(req), body)));
    });

    r.post(`${P}/:id/submit`, owner(), vId, async (req, res) => {
      res.json(view(await submitRestaurant(ctx, vId.get(req).params.id, userIdOf(req))));
    });

    r.post(`${P}/:id/resend-verification`, owner(), vId, async (req, res) => {
      res.status(202).json(await resendVerification(ctx, vId.get(req).params.id, userIdOf(req)));
    });

    const vSettle = validate({ params: RestaurantIdParams, body: SettlementBody });
    r.put(`${P}/:id/settlement`, owner(), vSettle, async (req, res) => {
      const { params, body } = vSettle.get(req);
      res.json(await setSettlement(ctx, params.id, userIdOf(req), body, req.ip));
    });

    const vHours = validate({ params: RestaurantIdParams, body: HoursBody });
    r.put(`${P}/:id/hours`, owner(), vHours, async (req, res) => {
      const { params, body } = vHours.get(req);
      res.json(view(await setHours(ctx, params.id, userIdOf(req), body.hours)));
    });

    const vPause = validate({ params: RestaurantIdParams, body: PauseBody });
    r.post(`${P}/:id/pause`, owner(), vPause, async (req, res) => {
      const { params, body } = vPause.get(req);
      res.json(view(await setPause(ctx, params.id, userIdOf(req), body.minutes)));
    });
    r.post(`${P}/:id/resume`, owner(), vId, async (req, res) => {
      res.json(view(await setPause(ctx, vId.get(req).params.id, userIdOf(req), null)));
    });

    const vUpload = validate({ params: RestaurantIdParams, body: OwnerUploadBody });
    r.post(`${P}/:id/uploads`, owner(), vUpload, async (req, res) => {
      const { params, body } = vUpload.get(req);
      await findOwned(ctx, params.id, userIdOf(req));
      res.status(201).json(await presignUpload(ctx.storage, ctx.config, { prefix: restaurantPrefix(params.id), ...body }));
    });

    const vDoc = validate({ params: RestaurantIdParams, body: DocumentBody });
    r.post(`${P}/:id/documents`, owner(), vDoc, async (req, res) => {
      const { params, body } = vDoc.get(req);
      res.status(201).json(await attachDocument(ctx, params.id, userIdOf(req), body));
    });
  },

  openapi(api) {
    const tags = ['owner-restaurants'];
    const params = RestaurantIdParams;
    const R = { 200: { description: 'Restaurant', content: json(RestaurantView) } };
    api.route({
      method: 'post', path: P, tags, security: 'bearer',
      summary: 'Create a DRAFT restaurant (grants RESTAURANT_OWNER — refresh your access token afterwards)',
      request: { body: { content: json(CreateBody) } },
      responses: { 201: { description: 'Created', content: json(z.object({ restaurant: RestaurantView, roleGranted: z.literal(true) })) } },
      errors: ['UPSTREAM_UNAVAILABLE'],
    });
    api.route({ method: 'get', path: P, tags, security: 'bearer', summary: 'My restaurants', responses: { 200: { description: 'List', content: json(z.object({ items: z.array(RestaurantView) })) } } });
    api.route({ method: 'get', path: `${P}/:id`, tags, security: 'bearer', summary: 'Get my restaurant', request: { params }, responses: R, errors: ['NOT_FOUND'] });
    api.route({
      method: 'patch', path: `${P}/:id`, tags, security: 'bearer',
      summary: 'Update profile. Changing businessEmail resets verification (back to VERIFICATION_PENDING if not yet approved). Image keys must come from the uploads presign and pass content verification.',
      request: { params, body: { content: json(ProfileBody) } }, responses: R, errors: ['NOT_FOUND', 'FILE_INVALID', 'CONCURRENT_MODIFICATION'],
    });
    api.route({
      method: 'post', path: `${P}/:id/submit`, tags, security: 'bearer',
      summary: 'Submit for verification/approval (DRAFT → VERIFICATION_PENDING; REJECTED → APPROVAL_PENDING if email still verified). 422 details.missing lists incomplete fields.',
      request: { params }, responses: R, errors: ['NOT_FOUND', 'RESTAURANT_INVALID_TRANSITION'],
    });
    api.route({
      method: 'post', path: `${P}/:id/resend-verification`, tags, security: 'bearer', summary: 'Resend the business-email verification link (60 s cooldown)',
      request: { params }, responses: { 202: { description: 'Sent', content: json(z.object({ sentAt: z.string(), expiresAt: z.string() })) } },
      errors: ['NOT_FOUND', 'CONFLICT', 'RATE_LIMITED'],
    });
    api.route({
      method: 'put', path: `${P}/:id/settlement`, tags, security: 'bearer', summary: 'Set settlement bank details (stored encrypted; only last4 is returned)',
      request: { params, body: { content: json(SettlementBody) } }, responses: { 200: { description: 'Masked settlement', content: json(SettlementView) } }, errors: ['NOT_FOUND'],
    });
    api.route({ method: 'put', path: `${P}/:id/hours`, tags, security: 'bearer', summary: 'Weekly hours (Asia/Kolkata; close < open = past midnight; open == close = 24 h)', request: { params, body: { content: json(HoursBody) } }, responses: R, errors: ['NOT_FOUND'] });
    api.route({ method: 'post', path: `${P}/:id/pause`, tags, security: 'bearer', summary: 'Pause ordering for N minutes', request: { params, body: { content: json(PauseBody) } }, responses: R, errors: ['NOT_FOUND'] });
    api.route({ method: 'post', path: `${P}/:id/resume`, tags, security: 'bearer', summary: 'Resume ordering', request: { params }, responses: R, errors: ['NOT_FOUND'] });
    api.route({
      method: 'post', path: `${P}/:id/uploads`, tags, security: 'bearer',
      summary: 'Presign an upload. IMAGE: image/jpeg|png|webp ≤ 2 MB (public). DOCUMENT: application/pdf|image/jpeg|png ≤ 5 MB (private). PUT the file with exactly the returned headers.',
      request: { params, body: { content: json(OwnerUploadBody) } }, responses: { 201: { description: 'Presigned PUT', content: json(PresignView) } }, errors: ['NOT_FOUND', 'FILE_INVALID'],
    });
    api.route({
      method: 'post', path: `${P}/:id/documents`, tags, security: 'bearer', summary: 'Attach an uploaded KYC document (size + magic bytes verified; invalid files are deleted)',
      request: { params, body: { content: json(DocumentBody) } }, responses: { 201: { description: 'Attached', content: json(DocumentView) } }, errors: ['NOT_FOUND', 'FILE_INVALID'],
    });
  },
};
