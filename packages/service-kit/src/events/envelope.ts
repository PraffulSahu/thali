/**
 * Event envelope (LLD 1.6) + stream naming helpers.
 *
 * Logical stream names are `events.<producer>` (e.g. `events.orders`); the Redis key is
 * `<EVENT_STREAM_PREFIX><logical name>` (`streamKey`). Consumer groups `cg.<service>`, DLQ stream
 * `dlq.<service>` (also prefixed).
 */
import { randomUUID } from 'node:crypto';
import type { EventEnvelope, EventPayloads, EventType, ServiceName } from '@thali/contracts';
import { currentRequestId } from '../request-id.js';

export interface CreateEnvelopeOptions {
  producer: ServiceName;
  /** e.g. childOrderId. */
  aggregateId: string;
  /** Defaults to the current HTTP request id (AsyncLocalStorage), else a fresh UUID. */
  correlationId?: string;
  /** Defaults to now. */
  occurredAt?: Date | string;
}

/** Build an envelope with a fresh UUID v4 `id` (the dedupe key) and `version: 1`. */
export function createEnvelope<T extends EventType>(type: T, payload: EventPayloads[T], opts: CreateEnvelopeOptions): EventEnvelope<T> {
  const occurredAt = opts.occurredAt === undefined ? new Date() : new Date(opts.occurredAt);
  return {
    id: randomUUID(),
    type,
    version: 1,
    occurredAt: occurredAt.toISOString(),
    producer: opts.producer,
    correlationId: opts.correlationId ?? currentRequestId() ?? randomUUID(),
    aggregateId: opts.aggregateId,
    payload,
  };
}

/** Logical stream a service publishes to: `events.<service>`. */
export function eventStreamName(service: ServiceName | string): string {
  return `events.${service}`;
}

/** Redis key of a logical stream: `<EVENT_STREAM_PREFIX><name>`. */
export function streamKey(streamPrefix: string | undefined, name: string): string {
  return `${streamPrefix ?? ''}${name}`;
}

/** Value of a field in a stream entry's flat `[k1, v1, k2, v2, ...]` list. */
export function entryField(fields: string[], name: string): string | undefined {
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i] === name) return fields[i + 1];
  return undefined;
}

/** Parse the `data` field of a stream entry; `null` if it is not an envelope-shaped JSON object. */
export function parseEnvelope(raw: string | undefined): EventEnvelope | null {
  if (raw === undefined) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const e = v as Partial<EventEnvelope>;
  if (typeof e.id !== 'string' || !e.id || typeof e.type !== 'string' || !e.type) return null;
  return e as EventEnvelope;
}
