/**
 * Service-to-service HTTP client (HLD 3.1): signs a fresh service token per request, propagates
 * `x-request-id` (explicit, else the current request's id, else a new UUID), enforces a timeout
 * (default 3 s) and retries only idempotent methods (GET/DELETE) on network errors, timeouts and
 * 502/503/504 — POST/PUT/PATCH are never retried.
 *
 * Errors:
 *  - upstream error envelope   → `UpstreamError` (a DomainError) preserving code/message/status/details,
 *    EXCEPT upstream auth rejections of the service call itself (any 401, or 403 with FORBIDDEN /
 *    MFA_REQUIRED / CSRF_CHECK_FAILED) → `UPSTREAM_ERROR` 502 (details `{ target, upstreamStatus,
 *    upstreamCode }`), so a misconfigured secret/allow-list never surfaces to clients as their own 401/403.
 *    Business 403s (e.g. PARTNER_NOT_APPROVED) are preserved.
 *  - non-envelope upstream 4xx/5xx, bad JSON, schema mismatch → `UPSTREAM_ERROR` 502
 *  - timeout                   → `UPSTREAM_TIMEOUT` 504
 *  - connection failure        → `UPSTREAM_UNAVAILABLE` 502
 */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { DomainError, ERROR_STATUS, type ErrorCode, type ServiceName } from '@thali/contracts';
import { signServiceToken } from '../auth/service-token.js';
import { currentRequestId, REQUEST_ID_HEADER } from '../request-id.js';

/** DomainError raised from an upstream service's error envelope. */
export class UpstreamError extends DomainError {
  readonly target: ServiceName;
  readonly upstreamStatus: number;
  readonly upstreamRequestId?: string;
  constructor(
    target: ServiceName,
    upstreamStatus: number,
    code: ErrorCode,
    message: string,
    httpStatus: number,
    details?: unknown,
    upstreamRequestId?: string,
  ) {
    super(code, message, httpStatus, details);
    this.name = 'UpstreamError';
    this.target = target;
    this.upstreamStatus = upstreamStatus;
    if (upstreamRequestId) this.upstreamRequestId = upstreamRequestId;
  }
}

export interface InternalClientOptions {
  /** Calling service (token `iss`), usually `config.SERVICE_NAME`. */
  from: ServiceName;
  /** `config.INTERNAL_SERVICE_SECRET`. */
  secret: string;
  /** Per-attempt timeout; default 3000 ms. */
  timeoutMs?: number;
  /** Retries for idempotent methods; default 2. */
  retries?: number;
  /** Injectable fetch (tests). */
  fetch?: typeof fetch;
}

export interface RequestOptions<S extends z.ZodType | undefined = undefined> {
  requestId?: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** Validate (and type) the JSON response. */
  schema?: S;
}

type Result<T, S> = S extends z.ZodType ? z.output<S> : T;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface InternalClient {
  readonly target: ServiceName;
  get<T = unknown, S extends z.ZodType | undefined = undefined>(path: string, opts?: RequestOptions<S>): Promise<Result<T, S>>;
  post<T = unknown, S extends z.ZodType | undefined = undefined>(path: string, body?: unknown, opts?: RequestOptions<S>): Promise<Result<T, S>>;
  put<T = unknown, S extends z.ZodType | undefined = undefined>(path: string, body?: unknown, opts?: RequestOptions<S>): Promise<Result<T, S>>;
  patch<T = unknown, S extends z.ZodType | undefined = undefined>(path: string, body?: unknown, opts?: RequestOptions<S>): Promise<Result<T, S>>;
  delete<T = unknown, S extends z.ZodType | undefined = undefined>(path: string, opts?: RequestOptions<S>): Promise<Result<T, S>>;
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const AUTH_403_CODES = new Set<ErrorCode>(['FORBIDDEN', 'MFA_REQUIRED', 'CSRF_CHECK_FAILED']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isErrorCode(c: unknown): c is ErrorCode {
  return typeof c === 'string' && Object.prototype.hasOwnProperty.call(ERROR_STATUS, c);
}

export function internalClient(target: ServiceName, baseUrl: string, opts: InternalClientOptions): InternalClient {
  const doFetch = opts.fetch ?? fetch;
  const base = baseUrl.replace(/\/+$/, '');

  async function attempt(method: Method, url: string, body: unknown, ro: RequestOptions<z.ZodType | undefined>, requestId: string) {
    const token = await signServiceToken(opts.from, target, opts.secret);
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      [REQUEST_ID_HEADER]: requestId,
      ...ro.headers,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const timeoutMs = ro.timeoutMs ?? opts.timeoutMs ?? 3000;
    try {
      return await doFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new DomainError('UPSTREAM_TIMEOUT', `${target} did not respond within ${timeoutMs} ms`, 504, { target });
      }
      throw new DomainError('UPSTREAM_UNAVAILABLE', `${target} is unreachable`, 502, { target });
    }
  }

  async function toResult(res: Response, schema: z.ZodType | undefined): Promise<unknown> {
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const env = (json as { error?: { code?: unknown; message?: unknown; details?: unknown; requestId?: unknown } })?.error;
      const upstreamRequestId = typeof env?.requestId === 'string' ? env.requestId : undefined;
      if (res.status === 401 || (res.status === 403 && (!env || !isErrorCode(env.code) || AUTH_403_CODES.has(env.code)))) {
        throw new UpstreamError(
          target,
          res.status,
          'UPSTREAM_ERROR',
          `${target} rejected the service call (${res.status})`,
          502,
          { target, upstreamStatus: res.status, upstreamCode: isErrorCode(env?.code) ? env.code : undefined },
          upstreamRequestId,
        );
      }
      if (env && isErrorCode(env.code)) {
        throw new UpstreamError(
          target,
          res.status,
          env.code,
          typeof env.message === 'string' ? env.message : env.code,
          res.status,
          env.details,
          upstreamRequestId,
        );
      }
      throw new UpstreamError(target, res.status, 'UPSTREAM_ERROR', `${target} responded ${res.status}`, 502, {
        target,
        status: res.status,
      });
    }
    if (!text) return undefined;
    if (json === undefined) {
      throw new DomainError('UPSTREAM_ERROR', `${target} returned a non-JSON response`, 502, { target });
    }
    if (schema) {
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new DomainError('UPSTREAM_ERROR', `${target} returned an unexpected response shape`, 502, { target });
      }
      return parsed.data;
    }
    return json;
  }

  async function request(method: Method, path: string, body: unknown, ro: RequestOptions<z.ZodType | undefined> = {}) {
    const url = new URL(base + (path.startsWith('/') ? path : `/${path}`));
    for (const [k, v] of Object.entries(ro.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const requestId = ro.requestId ?? currentRequestId() ?? randomUUID();
    const idempotent = method === 'GET' || method === 'DELETE';
    const maxRetries = idempotent ? (ro.retries ?? opts.retries ?? 2) : 0;

    for (let n = 0; ; n++) {
      try {
        const res = await attempt(method, url.toString(), body, ro, requestId);
        if (n < maxRetries && RETRYABLE_STATUS.has(res.status)) {
          await res.body?.cancel();
          await sleep(100 * 2 ** n);
          continue;
        }
        return await toResult(res, ro.schema);
      } catch (e) {
        const retryable =
          e instanceof DomainError && !(e instanceof UpstreamError) && (e.code === 'UPSTREAM_TIMEOUT' || e.code === 'UPSTREAM_UNAVAILABLE');
        if (retryable && n < maxRetries) {
          await sleep(100 * 2 ** n);
          continue;
        }
        throw e;
      }
    }
  }

  return {
    target,
    get: (path, ro) => request('GET', path, undefined, ro) as never,
    post: (path, body, ro) => request('POST', path, body ?? {}, ro) as never,
    put: (path, body, ro) => request('PUT', path, body ?? {}, ro) as never,
    patch: (path, body, ro) => request('PATCH', path, body ?? {}, ro) as never,
    delete: (path, ro) => request('DELETE', path, undefined, ro) as never,
  };
}
