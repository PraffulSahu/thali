/** `/api/v1/me` — profile, saved addresses (max 10, single default), notification prefs. */
import express, { type Router } from 'express';
import { DomainError, toGeoJsonPoint } from '@thali/contracts';
import { requireAuth, validate, withTransaction } from '@thali/service-kit';
import type { Ctx } from '../deps.js';
import { MAX_ADDRESSES, type UserDoc } from '../models/user.js';
import { oid, toAddressView, toUserView } from '../domain/views.js';
import { CreateAddressBody, IdParams, NotificationPrefsSchema, PatchAddressBody, PatchMeBody } from '../schemas.js';

export function meRouter(ctx: Ctx): Router {
  const { User } = ctx.m;
  const r = express.Router();
  r.use(requireAuth());

  const notFound = () => new DomainError('NOT_FOUND', 'User not found');
  const me = (req: express.Request) => {
    const id = oid(req.auth!.userId);
    if (!id) throw notFound();
    return id;
  };

  r.get('/', async (req, res) => {
    const user = await User.findById(me(req)).lean<UserDoc>();
    if (!user) throw notFound();
    res.json(toUserView(user));
  });

  const vPatch = validate({ body: PatchMeBody });
  r.patch('/', vPatch, async (req, res) => {
    const { body } = vPatch.get(req);
    const $set: Record<string, unknown> = {};
    if (body.name !== undefined) $set.name = body.name;
    if (body.email !== undefined) $set.email = body.email;
    try {
      const user = await User.findByIdAndUpdate(me(req), { $set }, { new: true }).lean<UserDoc>();
      if (!user) throw notFound();
      res.json(toUserView(user));
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new DomainError('CONFLICT', 'That email is already in use');
      throw e;
    }
  });

  r.get('/addresses', async (req, res) => {
    const user = await User.findById(me(req), { addresses: 1 }).lean<UserDoc>();
    if (!user) throw notFound();
    res.json({ items: (user.addresses ?? []).map((a) => toAddressView(a)) });
  });

  const vCreate = validate({ body: CreateAddressBody });
  r.post('/addresses', vCreate, async (req, res) => {
    const { body } = vCreate.get(req);
    const view = await withTransaction(ctx.conn, async (session) => {
      const user = await User.findById(me(req)).session(session);
      if (!user) throw notFound();
      if (user.addresses.length >= MAX_ADDRESSES) {
        throw new DomainError('VALIDATION_FAILED', `You can save up to ${MAX_ADDRESSES} addresses`, undefined, {
          field: 'addresses',
          max: MAX_ADDRESSES,
        });
      }
      const makeDefault = body.isDefault === true || user.addresses.length === 0;
      if (makeDefault) user.addresses.forEach((a) => (a.isDefault = false));
      user.addresses.push({ ...body, location: toGeoJsonPoint(body.location), isDefault: makeDefault });
      await user.save({ session });
      return toAddressView(user.addresses[user.addresses.length - 1]!);
    });
    res.status(201).json(view);
  });

  const vAddrId = validate({ params: IdParams, body: PatchAddressBody });
  r.patch('/addresses/:id', vAddrId, async (req, res) => {
    const { params, body } = vAddrId.get(req);
    const view = await withTransaction(ctx.conn, async (session) => {
      const user = await User.findById(me(req)).session(session);
      const addr = user && oid(params.id) ? user.addresses.id(params.id) : null;
      if (!user || !addr) throw new DomainError('NOT_FOUND', 'Address not found');
      const { location, isDefault, ...rest } = body;
      Object.assign(addr, rest);
      if (location) addr.location = toGeoJsonPoint(location);
      if (isDefault === true) user.addresses.forEach((a) => (a.isDefault = String(a._id) === String(addr._id)));
      else if (isDefault === false && addr.isDefault) {
        addr.isDefault = false;
        const other = user.addresses.find((a) => String(a._id) !== String(addr._id));
        if (other) other.isDefault = true;
        else addr.isDefault = true; // the only address stays default
      }
      await user.save({ session });
      return toAddressView(addr);
    });
    res.json(view);
  });

  const vDel = validate({ params: IdParams });
  r.delete('/addresses/:id', vDel, async (req, res) => {
    const { params } = vDel.get(req);
    await withTransaction(ctx.conn, async (session) => {
      const user = await User.findById(me(req)).session(session);
      const addr = user && oid(params.id) ? user.addresses.id(params.id) : null;
      if (!user || !addr) throw new DomainError('NOT_FOUND', 'Address not found');
      const wasDefault = addr.isDefault;
      addr.deleteOne();
      if (wasDefault && user.addresses.length > 0) user.addresses[0]!.isDefault = true;
      await user.save({ session });
    });
    res.status(204).end();
  });

  const vPrefs = validate({ body: NotificationPrefsSchema });
  r.put('/notification-prefs', vPrefs, async (req, res) => {
    const { body } = vPrefs.get(req);
    const user = await User.findByIdAndUpdate(me(req), { $set: { notificationPrefs: body } }, { new: true }).lean<UserDoc>();
    if (!user) throw notFound();
    res.json(toUserView(user).notificationPrefs);
  });

  return r;
}
