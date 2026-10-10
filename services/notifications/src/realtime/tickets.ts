/**
 * SSE tickets (HLD §3.3): the SPA exchanges its bearer token for a 30 s single-use ticket
 * (`POST /realtime/ticket`) and opens `EventSource(/realtime/stream?ticket=...)`, so access tokens never
 * appear in URLs. Stored in Redis as `rt:ticket:<sha256(ticket)>` -> JSON auth context; consumed atomically
 * with GETDEL, so a ticket can open exactly one stream.
 */
import { createHash, randomBytes } from 'node:crypto';
import { redisKey, type Redis } from '@thali/service-kit';
import type { AdminRole, Role } from '@thali/contracts';

export const TICKET_TTL_SEC = 30;

export interface TicketAuth {
  userId: string;
  roles: Role[];
  adminRoles: AdminRole[];
  sessionId: string;
  amr: string[];
}

const key = (redis: Redis, ticket: string) => redisKey(redis, `rt:ticket:${createHash('sha256').update(ticket).digest('hex')}`);

export async function issueTicket(redis: Redis, auth: TicketAuth): Promise<{ ticket: string; expiresInSec: number }> {
  const ticket = randomBytes(32).toString('base64url');
  await redis.set(key(redis, ticket), JSON.stringify(auth), 'EX', TICKET_TTL_SEC);
  return { ticket, expiresInSec: TICKET_TTL_SEC };
}

/** Atomically fetch-and-delete; `null` when unknown, expired or already used. */
export async function consumeTicket(redis: Redis, ticket: string): Promise<TicketAuth | null> {
  const raw = await redis.getdel(key(redis, ticket));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TicketAuth;
  } catch {
    return null;
  }
}
