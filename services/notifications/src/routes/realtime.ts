/** SSE: `POST /realtime/ticket` (auth) and `GET /realtime/stream?ticket=` (ticket only). HLD §3.3. */
import express, { type Router } from 'express';
import { DomainError } from '@thali/contracts';
import { rateLimit, requireAuth, validate, type Redis } from '@thali/service-kit';
import { StreamQuery } from '../openapi.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { consumeTicket, issueTicket } from '../realtime/tickets.js';

export function realtimeRouter(deps: { redis: Redis; hub: RealtimeHub }): Router {
  const { redis, hub } = deps;
  const r = express.Router();
  const vStream = validate({ query: StreamQuery });

  r.post(
    '/ticket',
    requireAuth(),
    rateLimit({ redis, name: 'rt-ticket', keyFn: (req) => req.auth!.userId, points: 30, durationSec: 60 }),
    async (req, res) => {
      const a = req.auth!;
      const out = await issueTicket(redis, { userId: a.userId, roles: a.roles, adminRoles: a.adminRoles, sessionId: a.sessionId, amr: a.amr });
      res.status(201).json(out);
    },
  );

  // A missing/invalid query is reported as 401, like an unknown ticket (no oracle for probing).
  r.get(
    '/stream',
    (req, _res, next) => {
      if (typeof req.query.ticket !== 'string' || req.query.ticket.length < 16 || req.query.ticket.length > 256) {
        return next(new DomainError('UNAUTHENTICATED', 'A valid realtime ticket is required'));
      }
      next();
    },
    vStream,
    async (req, res) => {
      const auth = await consumeTicket(redis, vStream.get(req).query.ticket);
      if (!auth) throw new DomainError('UNAUTHENTICATED', 'Realtime ticket is invalid, expired or already used');
      hub.attach(req, res, auth);
    },
  );

  return r;
}
