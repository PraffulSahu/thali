/**
 * Streaming reverse proxy on `node:http` (no proxy library, no body parsing).
 *
 *  - request body is piped to the upstream untouched, so raw bytes (webhook signatures!) are identical
 *  - hop-by-hop headers are stripped both ways; `x-forwarded-for/proto/host` + `x-request-id` are set
 *    by the gateway (client-supplied values are never forwarded verbatim; `req.ip` / `req.protocol` /
 *    `req.host` already honour `TRUST_PROXY`)
 *  - upstream status + headers are copied back as-is (identity's real 401s included); upstream CORS
 *    headers are dropped because CORS is decided at the gateway
 *  - 15 s idle timeout upstream (SSE exempt) -> 504 UPSTREAM_TIMEOUT; connection failure -> 502
 *    UPSTREAM_UNAVAILABLE (both are normal error-envelope responses)
 *  - SSE (`/api/v1/realtime/stream`): no timeout, headers flushed at once, `identity` encoding requested,
 *    `no-transform` / `x-accel-buffering: no` set, client disconnect destroys the upstream request
 *
 * Deliberately NOT service-kit's `internalClient` (it maps upstream 401/403 to 502).
 */
import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import { DomainError } from '@thali/contracts';
import { requestIdOf } from '@thali/service-kit';
import { isSsePath, PREFIX_MAP, resolveService, type RouteEntry, type UpstreamService } from './routes-map.js';

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 15_000;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Headers the gateway sets itself (never forwarded from the client). */
const GATEWAY_OWNED_REQUEST = new Set([
  'host',
  'expect',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-real-ip',
  'x-request-id',
]);

/** Names listed in `Connection: a, b` are hop-by-hop too (RFC 9110 7.6.1). */
function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection;
  const raw = Array.isArray(value) ? value.join(',') : (value ?? '');
  return new Set(
    raw
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function requestHeadersFor(req: Request, requestId: string): OutgoingHttpHeaders {
  const drop = connectionTokens(req.headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name) || drop.has(name) || GATEWAY_OWNED_REQUEST.has(name)) continue;
    out[name] = value;
  }
  // Body framing: Node re-frames the piped body; a chunked client body must stay chunked upstream even
  // for methods (e.g. DELETE) where Node would not default to chunked.
  if (out['content-length'] === undefined && /\bchunked\b/i.test(String(req.headers['transfer-encoding'] ?? ''))) {
    out['transfer-encoding'] = 'chunked';
  }
  out['x-request-id'] = requestId;
  out['x-forwarded-for'] = req.ip ?? req.socket.remoteAddress ?? '';
  out['x-forwarded-proto'] = req.protocol;
  const host = req.host;
  if (host) out['x-forwarded-host'] = host;
  return out;
}

function responseHeadersFor(upstream: IncomingMessage, res: Response, sse: boolean): OutgoingHttpHeaders {
  const drop = connectionTokens(upstream.headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name) || drop.has(name)) continue;
    if (name.startsWith('access-control-') || name === 'x-powered-by') continue;
    out[name] = value;
  }
  // keep the gateway's own `Vary: Origin` (CORS) alongside the upstream's
  const ownVary = res.getHeader('vary');
  if (ownVary) {
    const merged = new Set(
      [String(ownVary), String(out.vary ?? '')]
        .join(',')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    );
    out.vary = [...merged].join(', ');
  }
  if (sse) {
    out['cache-control'] = 'no-cache, no-transform';
    out['x-accel-buffering'] = 'no';
    delete out['content-length'];
    delete out['content-encoding'];
  }
  return out;
}

/** Reject path tricks that could make a service see a different path than the one that was routed. */
export function hasUnsafePath(path: string): boolean {
  if (path.includes('\\') || /%5c/i.test(path)) return true;
  return path.split('/').some((seg) => /^(\.|%2e){1,2}$/i.test(seg));
}

interface Target {
  client: typeof http;
  agent: http.Agent;
  hostname: string;
  port: number;
}

export interface ProxyOptions {
  upstreams: Record<UpstreamService, string>;
  /** Defaults to HLD 3.1 table. */
  routes?: readonly RouteEntry[];
  timeoutMs?: number;
  logger?: Logger;
}

export function createProxy(opts: ProxyOptions): RequestHandler {
  const routes = opts.routes ?? PREFIX_MAP;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgent = new https.Agent({ keepAlive: true });
  const targets = new Map<string, Target>();
  for (const [svc, base] of Object.entries(opts.upstreams)) {
    const u = new URL(base);
    const secure = u.protocol === 'https:';
    targets.set(svc, {
      client: (secure ? https : http) as typeof http,
      agent: secure ? (httpsAgent as unknown as http.Agent) : httpAgent,
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: Number(u.port || (secure ? 443 : 80)),
    });
  }

  return (req, res, next) => {
    const rawUrl = req.url;
    const q = rawUrl.indexOf('?');
    const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
    const service = resolveService(path, routes);
    if (!service || service === 'gateway') return next(); // -> 404 envelope
    if (hasUnsafePath(path)) return next(new DomainError('VALIDATION_FAILED', 'Invalid request path'));
    const target = targets.get(service);
    if (!target) return next(new DomainError('UPSTREAM_UNAVAILABLE', `${service} is not configured`));

    const requestId = requestIdOf(req);
    const sse = isSsePath(path);
    const headers = requestHeadersFor(req, requestId);
    if (sse) headers['accept-encoding'] = 'identity';
    const log = (req as unknown as { log?: Logger }).log ?? opts.logger;

    let timedOut = false;
    let clientGone = false;

    const upstreamReq = target.client.request(
      {
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: rawUrl,
        headers,
        agent: target.agent,
        ...(sse ? {} : { timeout: timeoutMs }),
      },
      (upstreamRes) => {
        const isStream = sse || /^text\/event-stream/i.test(String(upstreamRes.headers['content-type'] ?? ''));
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, responseHeadersFor(upstreamRes, res, isStream));
        if (isStream) {
          res.flushHeaders();
          res.socket?.setNoDelay(true);
        }
        upstreamRes.on('error', (err) => {
          if (!clientGone) log?.warn({ err, service }, 'upstream response failed mid-stream');
          res.destroy();
        });
        upstreamRes.on('aborted', () => res.destroy());
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on('timeout', () => {
      timedOut = true;
      upstreamReq.destroy(new Error('upstream timeout'));
    });
    upstreamReq.on('error', (err) => {
      req.unpipe(upstreamReq);
      req.resume(); // drain whatever the client is still sending
      if (clientGone) return;
      log?.warn({ err, service, timedOut }, timedOut ? 'upstream timed out' : 'upstream request failed');
      if (res.headersSent) {
        res.destroy();
        return;
      }
      next(
        timedOut
          ? new DomainError('UPSTREAM_TIMEOUT', `${service} did not respond within ${timeoutMs} ms`, undefined, { service })
          : new DomainError('UPSTREAM_UNAVAILABLE', `${service} is unreachable`, undefined, { service }),
      );
    });

    // Client went away (disconnect, abort, SSE tab closed) -> stop talking to the upstream.
    res.on('close', () => {
      if (!res.writableFinished) {
        clientGone = true;
        upstreamReq.destroy();
      }
    });

    req.pipe(upstreamReq);
  };
}
