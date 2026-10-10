/**
 * Request id middleware + async request context.
 *
 * Preserves a well-formed inbound `x-request-id` (generated at the gateway), otherwise generates a
 * UUID. The id is set on `req.id`, echoed in the `x-request-id` response header, and stored in an
 * AsyncLocalStorage so `internalClient` propagates it automatically (`currentRequestId()`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';
const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/;

interface RequestContext {
  requestId: string;
}
const storage = new AsyncLocalStorage<RequestContext>();

/** Request id of the HTTP request currently being handled (undefined outside a request). */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Run `fn` with a request id bound (e.g. inside event handlers: use the envelope correlationId). */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/** `req.id` as a string. */
export function requestIdOf(req: Request): string {
  return typeof req.id === 'string' ? req.id : String(req.id ?? '');
}

export function requestId(): RequestHandler {
  return (req, res, next) => {
    const inbound = req.header(REQUEST_ID_HEADER);
    const id = inbound && VALID_ID.test(inbound) ? inbound : randomUUID();
    req.id = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    storage.run({ requestId: id }, next);
  };
}
