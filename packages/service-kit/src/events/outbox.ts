/**
 * Transactional outbox: write the event in the SAME Mongo transaction as the state change. The relay
 * publishes it later; nothing is published if the transaction aborts.
 */
import type { ClientSession, Connection } from 'mongoose';
import type { EventEnvelope, EventPayloads, EventType } from '@thali/contracts';
import { createEnvelope, eventStreamName, type CreateEnvelopeOptions } from './envelope.js';
import { outboxModel } from './models.js';

/**
 * Insert an outbox row `{ _id: envelope.id, stream, envelope, createdAt, publishedAt: null, attempts: 0 }`
 * inside the caller's transaction. `stream` defaults to `events.<envelope.producer>`.
 * Throws if `session` is missing or not in a transaction.
 */
export async function enqueueEvent(conn: Connection, session: ClientSession, envelope: EventEnvelope, stream?: string): Promise<void> {
  if (!session) throw new Error('enqueueEvent requires the business transaction session (call it inside withTransaction)');
  if (!session.inTransaction()) throw new Error('enqueueEvent: session is not in a transaction (call it inside withTransaction)');
  await outboxModel(conn).create(
    [
      {
        _id: envelope.id,
        stream: stream ?? eventStreamName(envelope.producer),
        envelope: envelope as unknown as Record<string, unknown>,
        createdAt: new Date(),
        publishedAt: null,
        attempts: 0,
      },
    ],
    { session },
  );
}

/** `createEnvelope` + `enqueueEvent` in one call; returns the envelope. */
export async function emitEvent<T extends EventType>(
  conn: Connection,
  session: ClientSession,
  type: T,
  payload: EventPayloads[T],
  opts: CreateEnvelopeOptions & { stream?: string },
): Promise<EventEnvelope<T>> {
  const envelope = createEnvelope(type, payload, opts);
  await enqueueEvent(conn, session, envelope as EventEnvelope, opts.stream);
  return envelope;
}
