/**
 * Internal routes (binding shapes, docs/03-LLD.md):
 *   GET  /internal/users/:id                 (notifications, delivery, marketplace, orders)
 *   POST /internal/users/:id/roles {role}    (marketplace, delivery) → role.granted, idempotent
 *   POST /internal/users/:id/revoke-sessions (delivery, marketplace) → 204
 */
import express, { type Router } from 'express';
import { DomainError } from '@thali/contracts';
import { auditEvent, emitEvent, requireInternal, validate, withTransaction } from '@thali/service-kit';
import type { Ctx } from '../deps.js';
import { revokeUserSessions } from '../domain/sessions.js';
import { oid, toInternalUserView } from '../domain/views.js';
import type { UserDoc } from '../models/user.js';
import { GrantRoleBody, IdParams } from '../schemas.js';

export function internalRouter(ctx: Ctx): Router {
  const { User } = ctx.m;
  const r = express.Router();
  const notFound = () => new DomainError('NOT_FOUND', 'User not found');

  const vId = validate({ params: IdParams });
  r.get('/users/:id', requireInternal(['notifications', 'delivery', 'marketplace', 'orders']), vId, async (req, res) => {
    const id = oid(vId.get(req).params.id);
    const user = id ? await User.findById(id).lean<UserDoc>() : null;
    if (!user) throw notFound();
    res.json(toInternalUserView(user, ctx.imageUrl));
  });

  const vGrant = validate({ params: IdParams, body: GrantRoleBody });
  r.post('/users/:id/roles', requireInternal(['marketplace', 'delivery']), vGrant, async (req, res) => {
    const { params, body } = vGrant.get(req);
    const id = oid(params.id);
    if (!id) throw notFound();
    const caller = req.caller!.service;
    const user = await withTransaction(ctx.conn, async (session) => {
      const updated = await User.findOneAndUpdate({ _id: id, roles: { $ne: body.role } }, { $addToSet: { roles: body.role } }, { new: true, session }).lean<UserDoc>();
      if (!updated) {
        const existing = await User.findById(id).session(session).lean<UserDoc>();
        if (!existing) throw notFound();
        return existing; // already had the role — idempotent, no event
      }
      await emitEvent(ctx.conn, session, 'role.granted', { userId: String(id), role: body.role }, { producer: 'identity', aggregateId: String(id) });
      await auditEvent(ctx.conn, session, {
        service: 'identity',
        actorId: `service:${caller}`,
        actorRole: 'SYSTEM',
        action: 'user.role_grant',
        targetType: 'user',
        targetId: String(id),
        summary: `Granted ${body.role} (requested by ${caller})`,
      });
      return updated;
    });
    res.json({ userId: String(user._id), roles: [...user.roles] });
  });

  r.post('/users/:id/revoke-sessions', requireInternal(['delivery', 'marketplace']), vId, async (req, res) => {
    const id = oid(vId.get(req).params.id);
    if (!id || !(await User.exists({ _id: id }))) throw notFound();
    await revokeUserSessions(ctx, id, `INTERNAL:${req.caller!.service}`);
    res.status(204).end();
  });

  return r;
}
