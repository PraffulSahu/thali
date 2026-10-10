/**
 * `/api/v1/admin/users` (ADMIN + MFA): search/list, detail, block/unblock (revokes sessions, audited);
 * `/api/v1/admin/admins` (SUPER_ADMIN + MFA): create another admin (one-time password, audited).
 */
import express, { type Router } from 'express';
import { DomainError, type Role } from '@thali/contracts';
import { auditEvent, buildPage, cursorFilter, PAGE_SORT, requireAuth, validate, withTransaction } from '@thali/service-kit';
import type { Ctx } from '../deps.js';
import { bootstrapAdmin } from '../domain/admin-auth.js';
import { revokeUserSessionsTx, writeRevocations } from '../domain/sessions.js';
import { oid, toUserView } from '../domain/views.js';
import type { UserDoc } from '../models/user.js';
import { AdminUsersQuery, BlockBody, CreateAdminBody, IdParams } from '../schemas.js';
import { clientMeta } from './_http.js';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function actorRole(req: express.Request): string {
  const adm = req.auth!.adminRoles;
  return adm.length ? `ADMIN:${adm.join('|')}` : 'ADMIN';
}

export function adminUsersRouter(ctx: Ctx): Router {
  const { User } = ctx.m;
  const r = express.Router();
  const admin = requireAuth({ roles: ['ADMIN'], mfa: true });
  const manager = requireAuth({ roles: ['ADMIN'], mfa: true, adminRoles: ['OPS', 'SUPPORT'] });
  const superAdmin = requireAuth({ roles: ['ADMIN'], mfa: true, adminRoles: ['SUPER_ADMIN'] });

  const vList = validate({ query: AdminUsersQuery });
  r.get('/users', admin, vList, async (req, res) => {
    const { query } = vList.get(req);
    const filter: Record<string, unknown> = { ...cursorFilter(query.cursor) };
    if (query.role) filter.roles = query.role as Role;
    if (query.status) filter.status = query.status;
    if (query.q) {
      const rx = new RegExp(escapeRegex(query.q), 'i');
      const or: Record<string, unknown>[] = [{ phone: rx }, { email: rx }, { name: rx }];
      const id = oid(query.q);
      if (id) or.push({ _id: id });
      filter.$or = or;
    }
    const docs = await User.find(filter).sort(PAGE_SORT).limit(query.limit + 1).lean<UserDoc[]>();
    res.json(buildPage(docs, query.limit, toUserView));
  });

  const vId = validate({ params: IdParams });
  r.get('/users/:id', admin, vId, async (req, res) => {
    const { params } = vId.get(req);
    const id = oid(params.id);
    const user = id ? await User.findById(id).lean<UserDoc>() : null;
    if (!user) throw new DomainError('NOT_FOUND', 'User not found');
    res.json(toUserView(user));
  });

  const vBlock = validate({ params: IdParams, body: BlockBody });
  const setStatus = (to: 'BLOCKED' | 'ACTIVE') =>
    (async (req, res) => {
      const { params, body } = vBlock.get(req);
      const id = oid(params.id);
      if (!id) throw new DomainError('NOT_FOUND', 'User not found');
      if (String(id) === req.auth!.userId) throw new DomainError('CONFLICT', 'You cannot change your own account status');
      const { ip } = clientMeta(req);
      const { user, sids } = await withTransaction(ctx.conn, async (session) => {
        const before = await User.findById(id).session(session).lean<UserDoc>();
        if (!before) throw new DomainError('NOT_FOUND', 'User not found');
        let sids: string[] = [];
        if (before.status !== to) {
          await User.updateOne({ _id: id }, { $set: { status: to } }, { session });
          if (to === 'BLOCKED') sids = await revokeUserSessionsTx(ctx, id, 'ADMIN_BLOCK', session);
          await auditEvent(ctx.conn, session, {
            service: 'identity',
            actorId: req.auth!.userId,
            actorRole: actorRole(req),
            action: to === 'BLOCKED' ? 'user.block' : 'user.unblock',
            targetType: 'user',
            targetId: String(id),
            summary: `${to === 'BLOCKED' ? 'Blocked' : 'Unblocked'} user ${before.phone ?? before.email ?? String(id)}${body.reason ? `: ${body.reason}` : ''}`,
            ...(ip ? { ip } : {}),
          });
        }
        const user = await User.findById(id).session(session).lean<UserDoc>();
        return { user: user!, sids };
      });
      await writeRevocations(ctx, sids); // after commit (Redis side effect)
      res.json(toUserView(user));
    }) as express.RequestHandler;
  r.post('/users/:id/block', manager, vBlock, setStatus('BLOCKED'));
  r.post('/users/:id/unblock', manager, vBlock, setStatus('ACTIVE'));

  const vCreate = validate({ body: CreateAdminBody });
  r.post('/admins', superAdmin, vCreate, async (req, res) => {
    const { body } = vCreate.get(req);
    const { ip } = clientMeta(req);
    const { user, password } = await bootstrapAdmin(ctx.conn, body, {
      actorId: req.auth!.userId,
      actorRole: actorRole(req),
      ...(ip ? { ip } : {}),
    });
    res.status(201).json({ user: toUserView(user), oneTimePassword: password });
  });

  return r;
}
