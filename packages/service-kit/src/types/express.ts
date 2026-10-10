/**
 * Request context types + Express declaration merging (LLD 1.5).
 *
 * - `req.auth`    — set by `requireAuth()` for user tokens.
 * - `req.caller`  — set by `requireInternal()` for service tokens.
 * - `req.valid`   — set by `validate()` (parsed/coerced zod output).
 * - `req.rawBody` — exact request bytes for JSON / urlencoded bodies (webhook signatures).
 * - `req.id`      — request id (string; typed `ReqId` by pino-http's augmentation of
 *                   `http.IncomingMessage`). Use `requestIdOf(req)` for a `string`.
 * - `req.log`     — pino child logger bound to the request id (from pino-http).
 */
import type { AdminRole, Role, ServiceName } from '@thali/contracts';
import type { ReqId } from 'pino-http';

/** Authenticated end-user context (access JWT claims `sub, roles, sid, amr, adm`). */
export interface AuthContext {
  userId: string;
  roles: Role[];
  sessionId: string;
  amr: string[];
  /** Admin sub-roles from claim `adm` (empty for non-admins). */
  adminRoles: AdminRole[];
}

/** Authenticated internal caller (service token `iss`). */
export interface CallerContext {
  service: ServiceName;
}

/** Values parsed by `validate()`. Prefer the typed `validator.get(req)` accessor. */
export interface ValidatedRequest {
  body?: unknown;
  query?: unknown;
  params?: unknown;
  headers?: unknown;
}

/** Request id as typed by pino-http (the kit always sets a string). */
export type RequestId = ReqId;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      caller?: CallerContext;
      valid: ValidatedRequest;
      rawBody?: Buffer;
    }
  }
}
