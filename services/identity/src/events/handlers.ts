/**
 * Identity event consumers: `audit.recorded` from every service stream → `audit_logs`.
 * The kit consumer dedupes by inbox (eventId) in the same transaction; the upsert on the unique
 * `eventId` makes the write itself idempotent too (e.g. after a dead-letter replay into a fresh inbox).
 */
import type { Connection } from 'mongoose';
import type { Logger } from 'pino';
import { startConsumer, type EventHandler, type EventHandlers, type Redis, type StartConsumerOptions } from '@thali/service-kit';
import { AuditLogModel } from '../models/audit-log.js';

/** `audit.recorded` is written by every service to its own stream (incl. notifications). */
export const AUDIT_STREAMS = [
  'events.identity',
  'events.marketplace',
  'events.orders',
  'events.payments',
  'events.delivery',
  'events.notifications',
];

export function identityEventHandlers(conn: Connection): EventHandlers {
  const AuditLog = AuditLogModel(conn);
  const onAudit: EventHandler<'audit.recorded'> = async (e, session) => {
    const p = e.payload;
    await AuditLog.updateOne(
      { eventId: e.id },
      {
        $setOnInsert: {
          eventId: e.id,
          actorId: p.actorId,
          actorRole: p.actorRole,
          action: p.action,
          targetType: p.targetType,
          targetId: p.targetId,
          summary: p.summary,
          ip: p.ip ?? null,
          correlationId: e.correlationId,
          service: p.service ?? e.producer,
          occurredAt: new Date(e.occurredAt),
        },
      },
      { upsert: true, session },
    );
  };
  return { 'audit.recorded': onAudit };
}

export function startIdentityConsumer(opts: {
  conn: Connection;
  redis: Redis;
  logger: Logger;
  streamPrefix: string;
  overrides?: Partial<StartConsumerOptions>;
}) {
  return startConsumer({
    conn: opts.conn,
    redis: opts.redis,
    logger: opts.logger,
    service: 'identity',
    streamPrefix: opts.streamPrefix,
    streams: AUDIT_STREAMS,
    handlers: identityEventHandlers(opts.conn),
    ...opts.overrides,
  });
}
