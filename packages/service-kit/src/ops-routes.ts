/**
 * Internal ops routes every service mounts (HLD 8, admin health page):
 *   GET  /internal/health/details              → healthDetails(...)
 *   GET  /internal/dead-letters?limit&includeReplayed → { items: DeadLetterView[] }
 *   POST /internal/dead-letters/:id/replay     → { id, stream, entryId }
 * All behind `requireInternal(allowed)`. Register the OpenAPI docs with `registerOpsRoutes(openapi)`.
 */
import express, { type Router } from 'express';
import type { Redis } from 'ioredis';
import type { Connection } from 'mongoose';
import { z } from 'zod';
import type { ServiceName } from '@thali/contracts';
import { requireInternal } from './auth/require-internal.js';
import type { BaseConfig } from './config.js';
import { listDeadLetters, replayDeadLetter } from './events/dead-letters.js';
import type { DeadLetterRecord } from './events/models.js';
import { healthDetails } from './health-details.js';
import type { OpenApi } from './openapi.js';

export interface OpsRouterOptions {
  conn: Connection;
  redis: Redis;
  config: Pick<BaseConfig, 'SERVICE_NAME' | 'APP_MODE' | 'EVENT_STREAM_PREFIX'>;
  /** Logical streams this service consumes (for consumer lag). */
  streams?: string[];
  /** Services allowed to call (default: any service with a valid token). */
  allowed?: ServiceName[];
}

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  includeReplayed: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

function view(d: DeadLetterRecord) {
  return {
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
  };
}

export function createOpsRouter(opts: OpsRouterOptions): Router {
  const { conn, redis, config } = opts;
  const r = express.Router();
  const guard = requireInternal(opts.allowed);

  r.get('/internal/health/details', guard, async (_req, res) => {
    res.json(
      await healthDetails({
        conn,
        redis,
        service: config.SERVICE_NAME,
        mode: config.APP_MODE,
        streams: opts.streams,
        streamPrefix: config.EVENT_STREAM_PREFIX,
      }),
    );
  });

  r.get('/internal/dead-letters', guard, async (req, res) => {
    const q = ListQuery.parse(req.query);
    const items = await listDeadLetters(conn, { limit: q.limit, includeReplayed: q.includeReplayed });
    res.json({ items: items.map(view) });
  });

  r.post('/internal/dead-letters/:id/replay', guard, async (req, res) => {
    const id = String(req.params.id);
    res.json(await replayDeadLetter(conn, redis, id, { streamPrefix: config.EVENT_STREAM_PREFIX }));
  });

  return r;
}

const json = (schema: z.ZodType) => ({ 'application/json': { schema } });

export const HealthDetailsSchema = z
  .object({
    service: z.string(),
    mode: z.enum(['demo', 'sandbox', 'production']),
    mongo: z.enum(['up', 'down']),
    redis: z.enum(['up', 'down']),
    outboxPending: z.number().int().nullable(),
    outboxOldestAgeSec: z.number().int().nullable(),
    consumerLag: z.record(z.string(), z.number().int().nullable()),
    deadLetters: z.number().int().nullable(),
    providerErrorsLastHour: z.number().int().nullable(),
    providerErrorsByProvider: z.record(z.string(), z.number().int()).nullable(),
    checkedAt: z.string(),
  })
  .meta({ id: 'HealthDetails' });

export const DeadLetterViewSchema = z
  .object({
    id: z.string(),
    stream: z.string(),
    entryId: z.string(),
    service: z.string(),
    envelope: z.unknown(),
    error: z.string(),
    attempts: z.number().int(),
    failedAt: z.string(),
    replayedAt: z.string().nullable(),
    replayCount: z.number().int(),
  })
  .meta({ id: 'DeadLetter' });

/** Register the ops routes in a service's OpenAPI document. */
export function registerOpsRoutes(openapi: OpenApi): void {
  openapi.route({
    method: 'get',
    path: '/internal/health/details',
    tags: ['internal'],
    summary: 'Live health details (outbox backlog, consumer lag, dead letters, provider errors)',
    security: 'internal',
    responses: { 200: { description: 'Health details', content: json(HealthDetailsSchema) } },
  });
  openapi.route({
    method: 'get',
    path: '/internal/dead-letters',
    tags: ['internal'],
    summary: 'List dead-lettered events (newest first)',
    security: 'internal',
    request: { query: ListQuery.extend({ includeReplayed: z.enum(['true', 'false']).optional() }) },
    responses: { 200: { description: 'Dead letters', content: json(z.object({ items: z.array(DeadLetterViewSchema) })) } },
  });
  openapi.route({
    method: 'post',
    path: '/internal/dead-letters/:id/replay',
    tags: ['internal'],
    summary: 'Re-publish a dead-lettered event to its original stream',
    security: 'internal',
    request: { params: z.object({ id: z.string() }) },
    errors: ['NOT_FOUND', 'CONFLICT'],
    responses: {
      200: { description: 'Replayed', content: json(z.object({ id: z.string(), stream: z.string(), entryId: z.string() })) },
    },
  });
}
