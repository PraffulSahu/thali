/**
 * `Idempotency-Key` middleware (LLD 1.4). Mount AFTER `requireAuth` (the key is scoped per user).
 *
 * Record `idempotency_keys`: `{ _id: '<scope>:<userId|anon>:<key>', requestHash, status:
 * IN_PROGRESS|COMPLETED, responseStatus, responseBody, createdAt, lockedAt }`, TTL 24 h on createdAt.
 * `requestHash = sha256(METHOD \n path \n canonicalJSON(body))` (object keys sorted, so key order
 * does not matter).
 *
 *  - missing header: 400 IDEMPOTENCY_KEY_REQUIRED (or pass-through when `required: false`)
 *  - malformed header (not 8–128 `[A-Za-z0-9_-]`): 400 VALIDATION_FAILED
 *  - first request claims the key (atomic insert) and runs the handler
 *  - response < 400 → stored COMPLETED and replayed for identical retries (header `Idempotent-Replayed: true`)
 *  - response ≥ 400 (incl. thrown errors) or client abort → key released, a retry runs again
 *  - same key, different hash → 409 IDEMPOTENCY_CONFLICT; still running → 409 IDEMPOTENCY_IN_PROGRESS
 *  - an IN_PROGRESS claim older than `lockTimeoutSec` (crashed instance) is taken over
 *
 * Responses must be sent with `res.json(...)` (or an empty `res.status(204).end()`).
 */
import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { Schema, type Connection, type Model } from 'mongoose';
import { DomainError, IdempotencyKeySchema } from '@thali/contracts';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_COLLECTION = 'idempotency_keys';
export const IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;

export interface IdempotencyRecord {
  _id: string;
  requestHash: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  responseStatus?: number;
  responseBody?: unknown;
  createdAt: Date;
  lockedAt: Date;
}

const schema = new Schema<IdempotencyRecord>(
  {
    _id: { type: String, required: true },
    requestHash: { type: String, required: true },
    status: { type: String, enum: ['IN_PROGRESS', 'COMPLETED'], required: true },
    responseStatus: Number,
    responseBody: Schema.Types.Mixed,
    createdAt: { type: Date, required: true },
    lockedAt: { type: Date, required: true },
  },
  { collection: IDEMPOTENCY_COLLECTION, versionKey: false, minimize: false },
);
schema.index({ createdAt: 1 }, { expireAfterSeconds: IDEMPOTENCY_TTL_SEC });

/** The `idempotency_keys` model on `conn` (created once per connection). */
export function idempotencyModel(conn: Connection): Model<IdempotencyRecord> {
  return (conn.models.IdempotencyKey as Model<IdempotencyRecord> | undefined) ?? conn.model<IdempotencyRecord>('IdempotencyKey', schema);
}

/** Deterministic JSON: object keys sorted recursively; `undefined` → ''. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return '';
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

export function requestHash(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method.toUpperCase()}\n${path}\n${canonicalJson(body)}`).digest('hex');
}

export interface IdempotencyOptions {
  /** Operation scope, e.g. `checkout`, `membership-purchase`, `admin-refund`. */
  scope: string;
  conn: Connection;
  /** Default true. */
  required?: boolean;
  /** Take over an IN_PROGRESS claim older than this; default 60 s. */
  lockTimeoutSec?: number;
}

function isDuplicateKey(e: unknown): boolean {
  return (e as { code?: number })?.code === 11000;
}

export function idempotency(opts: IdempotencyOptions): RequestHandler {
  const lockTimeoutMs = (opts.lockTimeoutSec ?? 60) * 1000;

  return async (req, res, next) => {
    const header = req.header(IDEMPOTENCY_HEADER);
    if (!header) {
      if (opts.required === false) return next();
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', `${IDEMPOTENCY_HEADER} header is required`);
    }
    if (!IdempotencyKeySchema.safeParse(header).success) {
      throw new DomainError('VALIDATION_FAILED', `${IDEMPOTENCY_HEADER} must be 8-128 characters [A-Za-z0-9_-]`, undefined, {
        issues: [{ path: `headers.${IDEMPOTENCY_HEADER.toLowerCase()}`, code: 'invalid_format', message: 'Invalid Idempotency-Key' }],
      });
    }

    const Model = idempotencyModel(opts.conn);
    const owner = req.auth?.userId ?? 'anon';
    const id = `${opts.scope}:${owner}:${header}`;
    const path = (req.originalUrl ?? req.url).split('?')[0]!;
    const hash = requestHash(req.method, path, req.body);
    const now = new Date();

    let claimed = false;
    try {
      await Model.collection.insertOne({
        _id: id as never,
        requestHash: hash,
        status: 'IN_PROGRESS',
        createdAt: now,
        lockedAt: now,
      });
      claimed = true;
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
    }

    if (!claimed) {
      const existing = await Model.findById(id).lean<IdempotencyRecord>();
      if (!existing) {
        // released between our insert attempt and read: ask the client to retry
        throw new DomainError('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is in progress');
      }
      if (existing.requestHash !== hash) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request');
      }
      if (existing.status === 'COMPLETED') {
        res.setHeader('Idempotent-Replayed', 'true');
        res.status(existing.responseStatus ?? 200);
        if (existing.responseBody === undefined || existing.responseBody === null) res.end();
        else res.json(existing.responseBody);
        return;
      }
      const takenOver = await Model.collection.findOneAndUpdate(
        { _id: id as never, status: 'IN_PROGRESS', requestHash: hash, lockedAt: { $lt: new Date(Date.now() - lockTimeoutMs) } },
        { $set: { lockedAt: new Date() } },
      );
      if (!takenOver) {
        throw new DomainError('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is in progress');
      }
    }

    // We own the key: capture the response and persist (or release) before it is sent.
    let settled = false;
    const release = async () => {
      settled = true;
      await Model.collection.deleteOne({ _id: id as never, status: 'IN_PROGRESS' });
    };
    const complete = async (status: number, body: unknown) => {
      settled = true;
      await Model.collection.updateOne(
        { _id: id as never },
        { $set: { status: 'COMPLETED', responseStatus: status, responseBody: body ?? null } },
      );
    };

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      const persist = status < 400 ? complete(status, body) : release();
      persist
        .catch((err) => req.log?.error({ err, idempotencyKey: id }, 'idempotency record update failed'))
        .finally(() => originalJson(body));
      return res;
    };

    res.on('finish', () => {
      if (settled) return;
      const op = res.statusCode < 400 ? complete(res.statusCode, null) : release();
      op.catch((err) => req.log?.error({ err, idempotencyKey: id }, 'idempotency record update failed'));
    });
    res.on('close', () => {
      if (!settled && !res.writableFinished) {
        release().catch((err) => req.log?.error({ err, idempotencyKey: id }, 'idempotency release failed'));
      }
    });

    next();
  };
}
