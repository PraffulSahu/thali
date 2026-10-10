/** 🔓 Restaurant page, cuisines, banners, business-email verification link (PRD C-4, LLD 4.6). */
import { z } from 'zod';
import { validate } from '@thali/service-kit';
import type { RouteModule } from '../context.js';
import { getPublicRestaurant } from '../domain/discovery.js';
import { redirectUrl, verifyEmailToken } from '../domain/email-verification.js';
import { API, json, RatingView } from './common.js';

const RestaurantPageQuery = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});
const VerifyQuery = z.object({ token: z.string().max(200).optional() });

const PublicOption = z.object({ id: z.string(), name: z.string(), pricePaise: z.number(), isVeg: z.boolean(), available: z.boolean() });
const PublicItem = z
  .object({
    id: z.string(),
    restaurantId: z.string(),
    categoryId: z.string(),
    name: z.string(),
    description: z.string(),
    pricePaise: z.number(),
    isVeg: z.boolean(),
    imageUrl: z.string().nullable(),
    available: z.boolean().describe('false when toggled off or tracked stock is exhausted'),
    customizationGroups: z.array(z.object({ id: z.string(), name: z.string(), minSelect: z.number(), maxSelect: z.number(), options: z.array(PublicOption) })),
    tags: z.array(z.string()),
  })
  .meta({ id: 'PublicMenuItem' });
const RestaurantPage = z
  .object({
    restaurant: z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      description: z.string(),
      cuisines: z.array(z.string()),
      imageUrl: z.string().nullable(),
      logoUrl: z.string().nullable(),
      address: z.object({ line1: z.string(), line2: z.string().optional(), city: z.string(), pincode: z.string() }).nullable(),
      location: z.object({ lat: z.number(), lng: z.number() }).nullable(),
      hours: z.array(z.object({ day: z.number(), open: z.string(), close: z.string() })),
      timezone: z.string(),
      open: z.boolean(),
      closedReason: z.enum(['PAUSED', 'OUTSIDE_HOURS', 'NOT_APPROVED']).optional(),
      nextOpenAt: z.string().optional(),
      isVeg: z.enum(['PURE_VEG', 'MIXED']).optional(),
      priceBand: z.number().nullable(),
      rating: RatingView,
      packagingFeePaise: z.number(),
      avgPrepMinutes: z.number(),
      isDemo: z.boolean(),
    }),
    delivery: z
      .object({
        deliverable: z.boolean(),
        reason: z.string().optional(),
        distanceKm: z.number().nullable(),
        deliveryFeePaise: z.number().optional(),
        etaMinutes: z.number().optional(),
        etaSource: z.string().optional(),
        minOrderPaise: z.number().optional(),
      })
      .nullable()
      .describe('Present when lat/lng are given'),
    menu: z.array(z.object({ id: z.string(), name: z.string(), sortOrder: z.number(), items: z.array(PublicItem) })),
  })
  .meta({ id: 'RestaurantPage' });
const CuisineView = z.object({ id: z.string(), name: z.string(), slug: z.string(), imageUrl: z.string().nullable(), sortOrder: z.number() }).meta({ id: 'Cuisine' });
const BannerView = z
  .object({ id: z.string(), title: z.string(), imageUrl: z.string(), linkType: z.enum(['RESTAURANT', 'CUISINE', 'COUPON']), linkValue: z.string(), activeFrom: z.string(), activeTo: z.string(), isDemo: z.boolean() })
  .meta({ id: 'Banner' });

export const restaurantsPublicRoutes: RouteModule = {
  name: 'restaurants-public',
  register(r, ctx) {
    // must precede /restaurants/:idOrSlug
    const vVerify = validate({ query: VerifyQuery });
    r.get(`${API}/restaurants/verify-email`, vVerify, async (req, res) => {
      const outcome = await verifyEmailToken(ctx, vVerify.get(req).query.token);
      res.redirect(302, redirectUrl(ctx.config.PUBLIC_WEB_URL, outcome));
    });

    const vPage = validate({ params: z.object({ idOrSlug: z.string().min(1).max(120) }), query: RestaurantPageQuery });
    r.get(`${API}/restaurants/:idOrSlug`, vPage, async (req, res) => {
      const { params, query } = vPage.get(req);
      const drop = query.lat !== undefined && query.lng !== undefined ? { lat: query.lat, lng: query.lng } : undefined;
      res.json(await getPublicRestaurant(ctx, params.idOrSlug, drop));
    });

    r.get(`${API}/cuisines`, async (_req, res) => {
      const rows = await ctx.models.Cuisine.find({ active: true }).sort({ sortOrder: 1, name: 1 }).lean();
      res.json({
        items: rows.map((c) => ({ id: String(c._id), name: c.name, slug: c.slug, imageUrl: c.imageKey ? ctx.storage.publicUrl(c.imageKey) : null, sortOrder: c.sortOrder ?? 0 })),
      });
    });

    r.get(`${API}/banners`, async (_req, res) => {
      const now = ctx.now();
      const rows = await ctx.models.Banner.find({ active: true, activeFrom: { $lte: now }, activeTo: { $gt: now } }).sort({ activeFrom: -1 }).limit(20).lean();
      res.json({
        items: rows.map((b) => ({
          id: String(b._id),
          title: b.title,
          imageUrl: ctx.storage.publicUrl(b.imageKey),
          linkType: b.linkType,
          linkValue: b.linkValue,
          activeFrom: b.activeFrom.toISOString(),
          activeTo: b.activeTo.toISOString(),
          isDemo: !!b.isDemo,
        })),
      });
    });
  },
  openapi(api) {
    const tags = ['restaurants'];
    api.route({
      method: 'get', path: `${API}/restaurants/verify-email`, tags,
      summary: 'Business-email verification link → 302 to `${PUBLIC_WEB_URL}/restaurant/onboarding?emailVerified=1|0&reason=invalid|expired|already_verified`',
      request: { query: VerifyQuery },
      responses: { 302: { description: 'Redirect to the SPA onboarding page' } },
    });
    api.route({
      method: 'get', path: `${API}/restaurants/:idOrSlug`, tags, summary: 'Approved restaurant with menu; pass lat/lng for a delivery estimate',
      request: { params: z.object({ idOrSlug: z.string() }), query: RestaurantPageQuery },
      responses: { 200: { description: 'Restaurant page', content: json(RestaurantPage) } }, errors: ['NOT_FOUND'],
    });
    api.route({ method: 'get', path: `${API}/cuisines`, tags: ['catalog'], summary: 'Active cuisines', responses: { 200: { description: 'Cuisines', content: json(z.object({ items: z.array(CuisineView) })) } } });
    api.route({ method: 'get', path: `${API}/banners`, tags: ['catalog'], summary: 'Currently active banners (isDemo marks demo content)', responses: { 200: { description: 'Banners', content: json(z.object({ items: z.array(BannerView) })) } } });
  },
};
