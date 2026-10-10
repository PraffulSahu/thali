/**
 * Admin routes (🛡 ADMIN + MFA): notification list/retry, cross-service event dead letters, and the demo-only
 * provider outage switch. Every mutation writes `audit.recorded` in the same transaction.
 */
import express, { type Router } from 'express';
import type { Connection } from 'mongoose';
import { DomainError } from '@thali/contracts';
import {
  PAGE_SORT,
  auditEvent,
  buildPage,
  cursorFilter,
  internalClient,
  listDeadLetters,
  replayDeadLetter,
  requireAuth,
  validate,
  withTransaction,
  type Redis,
} from '@thali/service-kit';
import type { NotificationsConfig } from '../config.js';
import type { Dispatcher } from '../domain/dispatcher.js';
import type { NotificationDoc, NotificationModel } from '../models/notification.js';
import {
  AdminListQuery,
  DeadLetterListQuery,
  DeadLetterReplayParams,
  FailModeBody,
  IdParams,
} from '../openapi.js';
import type { FailMode } from '../providers/fail-mode.js';

export interface DeadLetterView {
  id: string;
  stream: string;
  entryId: string;
  service: string;
  envelope: unknown;
  error: string;
  attempts: number;
  failedAt: string;
  replayedAt: string | null;
  replayCount: number;
}

/** One service's event DLQ (remote via internal HTTP, or this service's own). */
export interface DeadLetterSource {
  service: string;
  list(limit: number): Promise<DeadLetterView[]>;
  replay(id: string): Promise<{ id: string; stream: string; entryId: string }>;
}

/** Real sources: each peer's `GET /internal/dead-letters` + `POST /internal/dead-letters/:id/replay`. */
export function createRemoteDeadLetterSources(config: NotificationsConfig): DeadLetterSource[] {
  const peers = [
    ['identity', config.IDENTITY_URL],
    ['marketplace', config.MARKETPLACE_URL],
    ['orders', config.ORDERS_URL],
    ['payments', config.PAYMENTS_URL],
    ['delivery', config.DELIVERY_URL],
  ] as const;
  return peers.map(([service, url]) => {
    const client = internalClient(service, url, { from: 'notifications', secret: config.INTERNAL_SERVICE_SECRET });
    return {
      service,
      async list(limit) {
        const out = await client.get<{ items: DeadLetterView[] }>('/internal/dead-letters', { query: { limit, includeReplayed: 'false' } });
        return out.items;
      },
      replay: (id) => client.post(`/internal/dead-letters/${encodeURIComponent(id)}/replay`),
    };
  });
}

export function createLocalDeadLetterSource(conn: Connection, redis: Redis, streamPrefix: string): DeadLetterSource {
  return {
    service: 'notifications',
    async list(limit) {
      const items = await listDeadLetters(conn, { limit, includeReplayed: false });
      return items.map((d) => ({
        id: d._id,
        stream: d.stream,
        entryId: d.entryId,
        service: d.service,
        envelope: d.envelope,
        error: d.error,
        attempts: d.attempts,
        failedAt: new Date(d.failedAt).toISOString(),
        replayedAt: d.replayedAt ? new Date(d.replayedAt).toISOString() : null,
        replayCount: d.replayCount ?? 0,
      }));
    },
    replay: (id) => replayDeadLetter(conn, redis, id, { streamPrefix }),
  };
}

const view = (n: NotificationDoc & { _id: unknown }) => ({
  id: String(n._id),
  userId: n.userId ?? null,
  audience: n.audience ?? null,
  channel: n.channel,
  to: n.to,
  template: n.template,
  status: n.status,
  attempts: n.attempts,
  nextAttemptAt: n.nextAttemptAt ? n.nextAttemptAt.toISOString() : null,
  provider: n.provider ?? null,
  providerMessageId: n.providerMessageId ?? null,
  lastError: n.lastError ?? null,
  skipReason: n.skipReason ?? null,
  sourceEventId: n.sourceEventId ?? null,
  dedupeKey: n.dedupeKey,
  readAt: n.readAt ? n.readAt.toISOString() : null,
  createdAt: n.createdAt.toISOString(),
  updatedAt: n.updatedAt.toISOString(),
});

const errorSummary = (service: string, err: unknown) => {
  const e = err as { code?: unknown; message?: unknown };
  return { service, code: typeof e.code === 'string' ? e.code : 'UPSTREAM_ERROR', message: String(e.message ?? 'unreachable').slice(0, 300) };
};

export interface AdminDeps {
  config: NotificationsConfig;
  conn: Connection;
  Notification: NotificationModel;
  dispatcher: Dispatcher;
  failMode: FailMode;
  deadLetterSources: DeadLetterSource[];
  now: () => Date;
}

export function adminRouter(deps: AdminDeps): Router {
  const { config, conn, Notification, dispatcher, failMode, now } = deps;
  const sources = new Map(deps.deadLetterSources.map((s) => [s.service, s]));
  const r = express.Router();
  const admin = requireAuth({ roles: ['ADMIN'], mfa: true });
  const actorRole = (req: express.Request) => (req.auth!.adminRoles[0] ? `ADMIN:${req.auth!.adminRoles[0]}` : 'ADMIN');

  const vList = validate({ query: AdminListQuery });
  r.get('/', admin, vList, async (req, res) => {
    const { query } = vList.get(req);
    const filter: Record<string, unknown> = { ...cursorFilter(query.cursor) };
    if (query.status) filter.status = query.status;
    if (query.channel) filter.channel = query.channel;
    if (query.userId) filter.userId = query.userId;
    const docs = await Notification.find(filter).sort(PAGE_SORT).limit(query.limit + 1).lean();
    res.json(buildPage(docs, query.limit, view));
  });

  // ---- event dead letters across services ----
  const vDl = validate({ query: DeadLetterListQuery });
  r.get('/dead-letters', admin, vDl, async (req, res) => {
    const { query } = vDl.get(req);
    const names = [...sources.keys()];
    const settled = await Promise.allSettled([...sources.values()].map((s) => s.list(query.limit)));
    const items: DeadLetterView[] = [];
    const errors: { service: string; code: string; message: string }[] = [];
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') items.push(...result.value.map((d) => ({ ...d, service: names[i]! })));
      else errors.push(errorSummary(names[i]!, result.reason));
    });
    items.sort((a, b) => b.failedAt.localeCompare(a.failedAt));
    res.json({ items, errors, sources: names });
  });

  const vReplay = validate({ params: DeadLetterReplayParams });
  r.post('/dead-letters/:service/:id/replay', admin, vReplay, async (req, res) => {
    const { params } = vReplay.get(req);
    const source = sources.get(params.service);
    if (!source) {
      throw new DomainError('VALIDATION_FAILED', `Unknown service '${params.service}'`, undefined, { allowed: [...sources.keys()] });
    }
    const result = await source.replay(params.id); // upstream failures (404, 502, ...) propagate with their code
    await withTransaction(conn, (session) =>
      auditEvent(conn, session, {
        service: 'notifications',
        actorId: req.auth!.userId,
        actorRole: actorRole(req),
        action: 'dead_letter.replay',
        targetType: 'dead_letter',
        targetId: `${params.service}:${params.id}`,
        summary: `Replayed dead-lettered event ${params.id} in ${params.service}`,
        ip: req.ip,
      }),
    );
    res.json(result);
  });

  // ---- demo: simulate provider outages (404 outside demo, before any auth so mode is not leaked to anonymous callers) ----
  const vFail = validate({ body: FailModeBody });
  r.post(
    '/demo/fail-mode',
    (_req, _res, next) => (config.APP_MODE === 'demo' ? next() : next(new DomainError('NOT_FOUND', 'Not found'))),
    admin,
    vFail,
    async (req, res) => {
      const { body } = vFail.get(req);
      const state = await failMode.set(body);
      await withTransaction(conn, (session) =>
        auditEvent(conn, session, {
          service: 'notifications',
          actorId: req.auth!.userId,
          actorRole: actorRole(req),
          action: 'demo.fail_mode',
          targetType: 'provider',
          targetId: 'mock-providers',
          summary: `Demo provider outage: sms=${state.sms} email=${state.email}`,
          ip: req.ip,
        }),
      );
      res.json(state);
    },
  );

  // ---- retry ----
  const vId = validate({ params: IdParams });
  r.post('/:id/retry', admin, vId, async (req, res) => {
    const { params } = vId.get(req);
    const at = now();
    const updated = await withTransaction(conn, async (session) => {
      const doc = await Notification.findOneAndUpdate(
        { _id: params.id, status: { $in: ['DEAD', 'FAILED'] }, template: { $ne: 'otp' }, $or: [{ channel: 'IN_APP' }, { toEnc: { $ne: null } }, { userId: { $ne: null } }, { recipientChildOrderId: { $ne: null } }] },
        { $set: { status: 'QUEUED', attempts: 0, nextAttemptAt: at, updatedAt: at }, $unset: { sendingAt: 1 } },
        { new: true, session },
      ).lean();
      if (!doc) return null;
      await auditEvent(conn, session, {
        service: 'notifications',
        actorId: req.auth!.userId,
        actorRole: actorRole(req),
        action: 'notification.retry',
        targetType: 'notification',
        targetId: params.id,
        summary: `Re-queued ${doc.channel} notification (${doc.template})`,
        ip: req.ip,
      });
      return doc;
    });
    if (!updated) {
      throw (await Notification.exists({ _id: params.id }))
        ? new DomainError('CONFLICT', 'Only DEAD or FAILED notifications can be retried (OTP notifications never can)')
        : new DomainError('NOT_FOUND', 'Notification not found');
    }
    dispatcher.kick([params.id]);
    res.json(view(updated));
  });

  return r;
}
