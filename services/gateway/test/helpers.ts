/**
 * Shared test helpers: fake upstream services (real local http servers) + a gateway config pointing at them.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { UpstreamService } from '../src/routes-map.js';
import { loadGatewayConfig, type GatewayConfig } from '../src/config.js';
import { TEST_INTERNAL_SERVICE_SECRET } from '@thali/service-kit/testing';

export const SERVICES: UpstreamService[] = ['identity', 'marketplace', 'orders', 'payments', 'delivery', 'notifications'];

export interface Upstream {
  name: UpstreamService;
  server: Server;
  url: string;
  port: number;
  /** Requests seen, in order. */
  hits: { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }[];
  close(): Promise<void>;
}

export type UpstreamHandler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

/** Start a fake upstream on an ephemeral port. Default handler echoes `{ service, method, url }` as JSON. */
export async function startUpstream(name: UpstreamService, handler?: UpstreamHandler): Promise<Upstream> {
  const hits: Upstream['hits'] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      hits.push({ method: req.method ?? 'GET', url: req.url ?? '', headers: req.headers, body });
      if (handler) return handler(req, res, body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ service: name, method: req.method, url: req.url }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    name,
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A URL on a port nothing listens on. */
export async function deadUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** Gateway config via the real env parser; `urls` overrides per-service base URLs. */
export function testGatewayConfig(
  urls: Partial<Record<UpstreamService, string>> = {},
  env: Record<string, string> = {},
): GatewayConfig {
  const e: Record<string, string> = {
    INTERNAL_SERVICE_SECRET: TEST_INTERNAL_SERVICE_SECRET,
    REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379',
    LOG_LEVEL: 'silent',
    ...env,
  };
  for (const svc of SERVICES) {
    const u = urls[svc];
    if (u) e[`${svc.toUpperCase()}_URL`] = u;
  }
  return loadGatewayConfig(e);
}
