/**
 * Audit trail (ADR-006): every privileged change enqueues `audit.recorded` on `events.<service>` in the
 * SAME transaction as the change; identity consumes it into `audit_logs`.
 */
import type { ClientSession, Connection } from 'mongoose';
import type { EventEnvelope, ServiceName } from '@thali/contracts';
import { createEnvelope } from './events/envelope.js';
import { enqueueEvent } from './events/outbox.js';

export interface AuditInput {
  /** Service recording the action (producer; stream `events.<service>`). */
  service: ServiceName;
  actorId: string;
  /** e.g. `ADMIN`, `ADMIN:FINANCE`, `RESTAURANT_OWNER`, `SYSTEM`. */
  actorRole: string;
  /** Dotted verb, e.g. `restaurant.approve`, `refund.manual_retry`. */
  action: string;
  targetType: string;
  targetId: string;
  /** Human readable; no secrets/PII beyond what admins may see. */
  summary: string;
  ip?: string;
  /** Defaults to the current request id. */
  correlationId?: string;
}

/** Enqueue `audit.recorded` (aggregateId = targetId) via the outbox; returns the envelope. */
export async function auditEvent(conn: Connection, session: ClientSession, input: AuditInput): Promise<EventEnvelope<'audit.recorded'>> {
  const { service, correlationId, ip, ...rest } = input;
  const envelope = createEnvelope(
    'audit.recorded',
    { ...rest, ...(ip ? { ip } : {}), service },
    { producer: service, aggregateId: input.targetId, ...(correlationId ? { correlationId } : {}) },
  );
  await enqueueEvent(conn, session, envelope as EventEnvelope, `events.${service}`);
  return envelope;
}
