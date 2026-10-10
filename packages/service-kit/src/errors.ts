/**
 * Error envelope (LLD 1.2): `{ error: { code, message, details?, requestId } }`.
 *
 * Mapping (in order):
 *  - `DomainError`                    → its `httpStatus` / code / message / details
 *  - `ZodError`                       → 400 `VALIDATION_FAILED`, `details.issues = [{ path, code, message }]`
 *  - body-parser `entity.too.large`   → 413 `PAYLOAD_TOO_LARGE`
 *  - other body-parser 4xx (bad JSON) → 400 `VALIDATION_FAILED`
 *  - `mongoose.Error.VersionError`    → 409 `CONCURRENT_MODIFICATION`
 *  - anything else                    → 500 `INTERNAL_ERROR`
 *
 * 5xx hygiene: unless internals are exposed (`NODE_ENV` is `development`/`test` AND `APP_MODE` is
 * not `production` — see `shouldExposeInternals`), every 5xx response carries only the code's
 * generic message (`GENERIC_5XX_MESSAGES`) and no `details` — for unknown errors AND DomainErrors
 * (whose messages may embed hosts, ids or upstream text).
 *
 * Mongo duplicate-key errors are deliberately NOT mapped: services must translate them into a
 * meaningful `DomainError` themselves. Stacks are never sent to clients; errors are logged with the
 * request id (5xx at `error`, 4xx at `info`). A `RATE_LIMITED` error with `details.retryAfterSec`
 * sets the `Retry-After` header.
 */
import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { DomainError, type ErrorCode } from '@thali/contracts';
import type { Logger } from 'pino';
import { requestIdOf } from './request-id.js';

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export interface ResolvedError {
  status: number;
  body: ErrorBody;
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

/** Flatten zod issues into the `details.issues` wire shape (`path` joined with `.`). */
export function zodIssues(err: z.ZodError, prefix?: string): ValidationIssue[] {
  return err.issues.map((i) => ({
    path: [...(prefix ? [prefix] : []), ...i.path.map(String)].join('.'),
    code: i.code,
    message: i.message,
  }));
}

interface HttpLikeError {
  status?: number;
  statusCode?: number;
  type?: string;
  expose?: boolean;
}

/** Client-safe messages for 5xx codes (anything else → `Internal server error`). */
export const GENERIC_5XX_MESSAGES: Partial<Record<ErrorCode, string>> = {
  INTERNAL_ERROR: 'Internal server error',
  SERVICE_UNAVAILABLE: 'Service temporarily unavailable',
  UPSTREAM_ERROR: 'An upstream service failed',
  UPSTREAM_UNAVAILABLE: 'An upstream service is unavailable',
  UPSTREAM_TIMEOUT: 'An upstream service timed out',
  PAYMENT_PROVIDER_UNAVAILABLE: 'Payment provider unavailable, please try again',
  OTP_DELIVERY_FAILED: 'Could not deliver the code, please try again',
};

/** Expose 5xx messages/details only in dev/test processes that are not in production mode. */
export function shouldExposeInternals(appMode: string, nodeEnv = process.env.NODE_ENV): boolean {
  return appMode !== 'production' && (nodeEnv === 'development' || nodeEnv === 'test');
}

export interface ResolveErrorOptions {
  /** Show real messages/details for 5xx (dev/test only). */
  exposeInternals: boolean;
}

function scrub(resolved: ResolvedError, expose: boolean): ResolvedError {
  if (expose || resolved.status < 500) return resolved;
  const code = resolved.body.code;
  return { status: resolved.status, body: { code, message: GENERIC_5XX_MESSAGES[code] ?? 'Internal server error' } };
}

/** Map any thrown value to an HTTP status + envelope body (5xx scrubbed unless `exposeInternals`). */
export function resolveError(err: unknown, opts: ResolveErrorOptions): ResolvedError {
  return scrub(classify(err), opts.exposeInternals);
}

function classify(err: unknown): ResolvedError {
  if (err instanceof DomainError) {
    return { status: err.httpStatus, body: err.toJSON() };
  }
  if (err instanceof z.ZodError) {
    return {
      status: 400,
      body: { code: 'VALIDATION_FAILED', message: 'Request validation failed', details: { issues: zodIssues(err) } },
    };
  }
  if (err instanceof mongoose.Error.VersionError) {
    return {
      status: 409,
      body: { code: 'CONCURRENT_MODIFICATION', message: 'The resource was modified concurrently; reload and retry' },
    };
  }
  const httpErr = (err ?? {}) as HttpLikeError;
  const status = httpErr.status ?? httpErr.statusCode;
  if (httpErr.type === 'entity.too.large' || status === 413) {
    return { status: 413, body: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } };
  }
  if (typeof status === 'number' && status >= 400 && status < 500 && httpErr.expose !== false) {
    const message = httpErr.type === 'entity.parse.failed' ? 'Malformed JSON body' : 'Invalid request';
    return { status: 400, body: { code: 'VALIDATION_FAILED', message } };
  }
  const message = err instanceof Error && err.message ? err.message : 'Internal server error';
  return { status: 500, body: { code: 'INTERNAL_ERROR', message } };
}

/** Write an envelope for `body` with the request id. */
export function sendError(req: Request, res: Response, status: number, body: ErrorBody): void {
  const retryAfter = (body.details as { retryAfterSec?: unknown } | undefined)?.retryAfterSec;
  if (body.code === 'RATE_LIMITED' && typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfter))));
  }
  const envelope = { error: { ...body, requestId: requestIdOf(req) } };
  res.status(status).json(envelope);
}

/** 404 for any unmatched route. */
export function notFoundHandler(): RequestHandler {
  return (req, _res, next) => {
    next(new DomainError('NOT_FOUND', `Route not found: ${req.method} ${req.path}`));
  };
}

/** Final error middleware. */
export function errorHandler(opts: { logger: Logger; exposeInternals: boolean }): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const { status, body } = resolveError(err, { exposeInternals: opts.exposeInternals });
    const log = (req as { log?: Logger }).log ?? opts.logger.child({ reqId: requestIdOf(req) });
    if (status >= 500) log.error({ err, code: body.code }, 'request failed');
    else log.info({ code: body.code, status, msg: body.message }, 'request rejected');
    sendError(req, res, status, body);
  };
}
