/** 🍽 Owner menu management: categories, items, customization groups, availability/stock (PRD R-3). */
import { z } from 'zod';
import { ObjectIdSchema, PaiseSchema } from '@thali/contracts';
import { requireAuth, validate } from '@thali/service-kit';
import type { RouteModule } from '../context.js';
import {
  createCategory,
  createItem,
  deleteCategory,
  deleteItem,
  getItem,
  listCategories,
  listItems,
  setAvailability,
  updateCategory,
  updateItem,
} from '../domain/menu.js';
import { API, json, RestaurantIdParams, userIdOf } from './common.js';

const Name = z.string().trim().min(1).max(80);

const OptionInput = z.object({
  id: ObjectIdSchema.optional(),
  name: Name,
  pricePaise: PaiseSchema,
  isVeg: z.boolean(),
  available: z.boolean().optional(),
});

export const CustomizationGroupInput = z
  .object({
    id: ObjectIdSchema.optional(),
    name: Name,
    minSelect: z.number().int().min(0),
    maxSelect: z.number().int().min(1),
    options: z.array(OptionInput).min(1).max(30),
  })
  .refine((g) => g.minSelect <= g.maxSelect, { message: 'minSelect must be <= maxSelect', path: ['minSelect'] })
  .refine((g) => g.maxSelect <= g.options.length, { message: 'maxSelect cannot exceed the number of options', path: ['maxSelect'] })
  .meta({ id: 'CustomizationGroupInput' });

const ItemFields = {
  categoryId: ObjectIdSchema,
  name: Name,
  description: z.string().trim().max(500).optional(),
  pricePaise: PaiseSchema,
  isVeg: z.boolean(),
  imageKey: z.string().trim().min(1).max(300).nullable().optional(),
  available: z.boolean().optional(),
  trackStock: z.boolean().optional(),
  stockQty: z.number().int().min(0).optional(),
  customizationGroups: z.array(CustomizationGroupInput).max(10).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
};
const ItemCreateBody = z.object(ItemFields).strict().meta({ id: 'MenuItemCreate' });
const ItemPatchBody = z.object(ItemFields).partial().strict().meta({ id: 'MenuItemPatch' });

const AvailabilityBody = z
  .object({ available: z.boolean().optional(), stockQty: z.number().int().min(0).optional(), trackStock: z.boolean().optional() })
  .strict()
  .refine((b) => b.available !== undefined || b.stockQty !== undefined || b.trackStock !== undefined, { message: 'Provide available, stockQty or trackStock' });

const CategoryCreateBody = z.object({ name: Name, sortOrder: z.number().int().min(0).max(10000).optional(), active: z.boolean().optional() }).strict();
const CategoryPatchBody = CategoryCreateBody.partial();

const CategoryView = z.object({ id: z.string(), restaurantId: z.string(), name: z.string(), sortOrder: z.number(), active: z.boolean() }).meta({ id: 'MenuCategory' });
const OptionView = z.object({ id: z.string(), name: z.string(), pricePaise: z.number(), isVeg: z.boolean(), available: z.boolean() });
const GroupView = z.object({ id: z.string(), name: z.string(), minSelect: z.number(), maxSelect: z.number(), options: z.array(OptionView) });
const OwnerItemView = z
  .object({
    id: z.string(),
    restaurantId: z.string(),
    categoryId: z.string(),
    name: z.string(),
    description: z.string(),
    pricePaise: z.number(),
    isVeg: z.boolean(),
    imageKey: z.string().nullable(),
    imageUrl: z.string().nullable(),
    available: z.boolean(),
    trackStock: z.boolean(),
    stockQty: z.number(),
    reservedQty: z.number(),
    availableQty: z.number().nullable(),
    customizationGroups: z.array(GroupView),
    tags: z.array(z.string()),
    updatedAt: z.string().nullable(),
  })
  .meta({ id: 'OwnerMenuItem' });

const CatParams = RestaurantIdParams.extend({ categoryId: z.string().min(1).max(64) });
const ItemParams = RestaurantIdParams.extend({ itemId: z.string().min(1).max(64) });
const ItemsQuery = z.object({ categoryId: z.string().max(64).optional() });

const owner = () => requireAuth({ roles: ['RESTAURANT_OWNER'] });
const P = `${API}/owner/restaurants/:id`;

export const ownerMenuRoutes: RouteModule = {
  name: 'owner-menu',
  register(r, ctx) {
    const vId = validate({ params: RestaurantIdParams });
    r.get(`${P}/categories`, owner(), vId, async (req, res) => {
      res.json({ items: await listCategories(ctx, vId.get(req).params.id, userIdOf(req)) });
    });
    const vCatCreate = validate({ params: RestaurantIdParams, body: CategoryCreateBody });
    r.post(`${P}/categories`, owner(), vCatCreate, async (req, res) => {
      const { params, body } = vCatCreate.get(req);
      res.status(201).json(await createCategory(ctx, params.id, userIdOf(req), body));
    });
    const vCatPatch = validate({ params: CatParams, body: CategoryPatchBody });
    r.patch(`${P}/categories/:categoryId`, owner(), vCatPatch, async (req, res) => {
      const { params, body } = vCatPatch.get(req);
      res.json(await updateCategory(ctx, params.id, userIdOf(req), params.categoryId, body));
    });
    const vCat = validate({ params: CatParams });
    r.delete(`${P}/categories/:categoryId`, owner(), vCat, async (req, res) => {
      const { params } = vCat.get(req);
      await deleteCategory(ctx, params.id, userIdOf(req), params.categoryId);
      res.status(204).end();
    });

    const vList = validate({ params: RestaurantIdParams, query: ItemsQuery });
    r.get(`${P}/items`, owner(), vList, async (req, res) => {
      const { params, query } = vList.get(req);
      res.json({ items: await listItems(ctx, params.id, userIdOf(req), query.categoryId) });
    });
    const vCreate = validate({ params: RestaurantIdParams, body: ItemCreateBody });
    r.post(`${P}/items`, owner(), vCreate, async (req, res) => {
      const { params, body } = vCreate.get(req);
      res.status(201).json(await createItem(ctx, params.id, userIdOf(req), body));
    });
    const vItem = validate({ params: ItemParams });
    r.get(`${P}/items/:itemId`, owner(), vItem, async (req, res) => {
      const { params } = vItem.get(req);
      res.json(await getItem(ctx, params.id, userIdOf(req), params.itemId));
    });
    const vPatch = validate({ params: ItemParams, body: ItemPatchBody });
    r.patch(`${P}/items/:itemId`, owner(), vPatch, async (req, res) => {
      const { params, body } = vPatch.get(req);
      res.json(await updateItem(ctx, params.id, userIdOf(req), params.itemId, body));
    });
    const vAvail = validate({ params: ItemParams, body: AvailabilityBody });
    r.patch(`${P}/items/:itemId/availability`, owner(), vAvail, async (req, res) => {
      const { params, body } = vAvail.get(req);
      res.json(await setAvailability(ctx, params.id, userIdOf(req), params.itemId, body));
    });
    r.delete(`${P}/items/:itemId`, owner(), vItem, async (req, res) => {
      const { params } = vItem.get(req);
      await deleteItem(ctx, params.id, userIdOf(req), params.itemId);
      res.status(204).end();
    });
  },

  openapi(api) {
    const tags = ['owner-menu'];
    const s = 'bearer' as const;
    const nf = ['NOT_FOUND'] as const;
    api.route({ method: 'get', path: `${P}/categories`, tags, security: s, summary: 'List categories', request: { params: RestaurantIdParams }, responses: { 200: { description: 'Categories', content: json(z.object({ items: z.array(CategoryView) })) } }, errors: [...nf] });
    api.route({ method: 'post', path: `${P}/categories`, tags, security: s, summary: 'Create category', request: { params: RestaurantIdParams, body: { content: json(CategoryCreateBody) } }, responses: { 201: { description: 'Created', content: json(CategoryView) } }, errors: [...nf] });
    api.route({ method: 'patch', path: `${P}/categories/:categoryId`, tags, security: s, summary: 'Update category', request: { params: CatParams, body: { content: json(CategoryPatchBody) } }, responses: { 200: { description: 'Updated', content: json(CategoryView) } }, errors: [...nf] });
    api.route({ method: 'delete', path: `${P}/categories/:categoryId`, tags, security: s, summary: 'Delete an empty category', request: { params: CatParams }, responses: { 204: { description: 'Deleted' } }, errors: ['NOT_FOUND', 'CONFLICT'] });
    api.route({ method: 'get', path: `${P}/items`, tags, security: s, summary: 'List items', request: { params: RestaurantIdParams, query: ItemsQuery }, responses: { 200: { description: 'Items', content: json(z.object({ items: z.array(OwnerItemView) })) } }, errors: [...nf] });
    api.route({ method: 'post', path: `${P}/items`, tags, security: s, summary: 'Create item (customization groups: minSelect ≤ maxSelect ≤ options.length)', request: { params: RestaurantIdParams, body: { content: json(ItemCreateBody) } }, responses: { 201: { description: 'Created', content: json(OwnerItemView) } }, errors: ['NOT_FOUND', 'FILE_INVALID'] });
    api.route({ method: 'get', path: `${P}/items/:itemId`, tags, security: s, summary: 'Get item', request: { params: ItemParams }, responses: { 200: { description: 'Item', content: json(OwnerItemView) } }, errors: [...nf] });
    api.route({ method: 'patch', path: `${P}/items/:itemId`, tags, security: s, summary: 'Update item (send existing group/option ids to keep them stable)', request: { params: ItemParams, body: { content: json(ItemPatchBody) } }, responses: { 200: { description: 'Updated', content: json(OwnerItemView) } }, errors: ['NOT_FOUND', 'CONFLICT', 'FILE_INVALID', 'CONCURRENT_MODIFICATION'] });
    api.route({ method: 'patch', path: `${P}/items/:itemId/availability`, tags, security: s, summary: 'Toggle availability / set tracked stock (cannot go below reserved)', request: { params: ItemParams, body: { content: json(AvailabilityBody) } }, responses: { 200: { description: 'Updated', content: json(OwnerItemView) } }, errors: ['NOT_FOUND', 'CONFLICT'] });
    api.route({ method: 'delete', path: `${P}/items/:itemId`, tags, security: s, summary: 'Delete item', request: { params: ItemParams }, responses: { 204: { description: 'Deleted' } }, errors: [...nf] });
  },
};
