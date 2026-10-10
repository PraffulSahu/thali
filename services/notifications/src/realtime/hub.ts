/**
 * SSE hub: one Redis pattern subscription per process fans messages out to the open streams
 * (HLD §3.3, LLD §11). Clients are registered under the channels their ticket entitles them to:
 * `user:<id>`, `owner:<id>`, `partner:<id>` and, for ADMIN tokens that completed MFA, `admin`.
 * Heartbeat comment `: ping` keeps proxies/load balancers from idling the connection out.
 */
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { realtimeChannel, subscribeRealtime, type RealtimeSubscription, type Redis } from '@thali/service-kit';
import type { TicketAuth } from './tickets.js';

export interface RealtimeHubOptions {
  redis: Redis;
  logger: Logger;
  heartbeatMs: number;
  /** Streams are closed after this long so revoked sessions cannot stay connected forever. */
  maxAgeMs: number;
  maxPerUser: number;
}

export interface RealtimeHub {
  attach(req: Request, res: Response, auth: TicketAuth): void;
  clientCount(): number;
  /** Ends every open stream and stops the Redis subscription (call before `server.close`). */
  close(): Promise<void>;
}

interface Client {
  userId: string;
  res: Response;
  channels: string[];
  end(): void;
}

const MAX_BUFFERED_BYTES = 1_000_000;

export function channelsFor(auth: TicketAuth): string[] {
  const channels = [realtimeChannel.user(auth.userId), realtimeChannel.owner(auth.userId), realtimeChannel.partner(auth.userId)];
  if (auth.roles.includes('ADMIN') && auth.amr.includes('mfa')) channels.push(realtimeChannel.admin());
  return channels;
}

const sseEvent = (event: string, data: unknown) => `event: ${event.replace(/[\r\n]/g, ' ')}\ndata: ${JSON.stringify(data)}\n\n`;

export async function createRealtimeHub(opts: RealtimeHubOptions): Promise<RealtimeHub> {
  const byChannel = new Map<string, Set<Client>>();
  const byUser = new Map<string, Client[]>();
  const all = new Set<Client>();

  const subscription: RealtimeSubscription = await subscribeRealtime(
    opts.redis,
    ['user:*', 'owner:*', 'partner:*', 'admin'],
    (channel, msg) => {
      const clients = byChannel.get(channel);
      if (!clients) return;
      const frame = sseEvent(msg.event, msg.data);
      for (const c of [...clients]) {
        if (c.res.writableLength > MAX_BUFFERED_BYTES) {
          opts.logger.warn({ userId: c.userId }, 'sse client too slow; closing');
          c.end();
        } else {
          c.res.write(frame);
        }
      }
    },
    { onError: (err) => opts.logger.warn({ err }, 'realtime subscription error') },
  );

  return {
    attach(req, res, auth) {
      // Make room first: the oldest streams of this user go.
      const existing = byUser.get(auth.userId) ?? [];
      while (existing.length >= opts.maxPerUser) existing.shift()?.end();

      let heartbeat: NodeJS.Timeout | undefined;
      let maxAge: NodeJS.Timeout | undefined;
      let closed = false;
      const client: Client = {
        userId: auth.userId,
        res,
        channels: channelsFor(auth),
        end() {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          clearTimeout(maxAge);
          all.delete(client);
          for (const ch of client.channels) {
            const set = byChannel.get(ch);
            set?.delete(client);
            if (set && set.size === 0) byChannel.delete(ch);
          }
          const list = byUser.get(client.userId);
          if (list) {
            const i = list.indexOf(client);
            if (i >= 0) list.splice(i, 1);
            if (list.length === 0) byUser.delete(client.userId);
          }
          if (!res.writableEnded) res.end();
        },
      };

      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
      req.socket.setKeepAlive(true);
      res.status(200);
      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();

      all.add(client);
      byUser.set(auth.userId, [...(byUser.get(auth.userId) ?? []), client]);
      for (const ch of client.channels) {
        if (!byChannel.has(ch)) byChannel.set(ch, new Set());
        byChannel.get(ch)!.add(client);
      }

      res.write('retry: 5000\n: connected\n\n');
      heartbeat = setInterval(() => res.write(': ping\n\n'), opts.heartbeatMs);
      maxAge = setTimeout(() => client.end(), opts.maxAgeMs);
      res.on('close', () => client.end());
    },
    clientCount: () => all.size,
    async close() {
      for (const c of [...all]) c.end();
      await subscription.close();
    },
  };
}
