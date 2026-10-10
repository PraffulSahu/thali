/** `GET /api/v1/admin/audit-logs` (ADMIN + MFA): filtered, cursor-paginated by `occurredAt desc, _id desc`. */
import express, { type Router } from 'express';
import { decodeCursor, encodeCursor, requireAuth, validate } from '@thali/service-kit';
import type { Ctx } from '../deps.js';
import type { AuditLogDoc } from '../models/audit-log.js';
import { toAuditLogView } from '../domain/views.js';
import { AuditLogsQuery } from '../schemas.js';

export function auditRouter(ctx: Ctx): Router {
  const r = express.Router();
  const v = validate({ query: AuditLogsQuery });
  r.get('/', requireAuth({ roles: ['ADMIN'], mfa: true }), v, async (req, res) => {
    const { query } = v.get(req);
    const filter: Record<string, unknown> = {};
    for (const k of ['targetType', 'targetId', 'actorId', 'action', 'service'] as const) {
      if (query[k]) filter[k] = query[k];
    }
    const range: Record<string, Date> = {};
    if (query.from) range.$gte = new Date(query.from);
    if (query.to) range.$lte = new Date(query.to);
    if (Object.keys(range).length) filter.occurredAt = range;
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      filter.$and = [{ $or: [{ occurredAt: { $lt: c.createdAt } }, { occurredAt: c.createdAt, _id: { $lt: c._id } }] }];
    }
    const docs = await ctx.m.AuditLog.find(filter).sort({ occurredAt: -1, _id: -1 }).limit(query.limit + 1).lean<AuditLogDoc[]>();
    const more = docs.length > query.limit;
    const page = more ? docs.slice(0, query.limit) : docs;
    const last = page[page.length - 1];
    res.json({
      items: page.map(toAuditLogView),
      nextCursor: more && last ? encodeCursor({ createdAt: last.occurredAt, _id: last._id }) : null,
    });
  });
  return r;
}
