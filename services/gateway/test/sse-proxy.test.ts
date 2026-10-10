import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testLogger } from '@thali/service-kit/testing';
import { buildApp } from '../src/app.js';
import { startUpstream, testGatewayConfig, type Upstream } from './helpers.js';

let upstream: Upstream;
let gateway: Server;
let port: number;
let upstreamClosed = 0;
let upstreamRequestHeaders: IncomingMessage['headers'] = {};
let stopTicker: (() => void) | undefined;

beforeAll(async () => {
  upstream = await startUpstream('notifications', (req, res) => {
    upstreamRequestHeaders = req.headers;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-thali-stream': 'rt-1',
    });
    res.flushHeaders();
    let n = 0;
    const timer = setInterval(() => res.write(`event: tick\nid: ${++n}\ndata: {"n":${n}}\n\n`), 50);
    res.on('close', () => {
      clearInterval(timer);
      upstreamClosed++;
    });
    stopTicker = () => clearInterval(timer);
  });
  // Long idle timeout config on purpose small: SSE must be exempt from it.
  const app = buildApp({
    config: testGatewayConfig({ notifications: upstream.url }, { UPSTREAM_TIMEOUT_MS: '200' }),
    logger: testLogger('gateway'),
  });
  gateway = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => gateway.once('listening', resolve));
  port = (gateway.address() as AddressInfo).port;
});
afterAll(async () => {
  stopTicker?.();
  gateway.closeAllConnections();
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  await upstream.close();
});

function openStream(headers: Record<string, string> = {}): Promise<{ res: IncomingMessage; abort: () => void; t0: number }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/api/v1/realtime/stream?ticket=abc', headers: { accept: 'text/event-stream', ...headers } },
      (res) => resolve({ res, abort: () => req.destroy(), t0 }),
    );
    req.on('error', reject);
    req.end();
  });
}

describe('SSE through the proxy (Review Focus #4)', () => {
  it('delivers the first event in < 500 ms (no buffering) with headers preserved', async () => {
    const { res, abort, t0 } = await openStream({ 'accept-encoding': 'gzip, br' });
    try {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.headers['x-thali-stream']).toBe('rt-1');
      expect(res.headers['content-encoding']).toBeUndefined(); // never compressed
      expect(res.headers['content-length']).toBeUndefined();
      expect(String(res.headers['cache-control'])).toMatch(/no-cache/);
      expect(String(res.headers['cache-control'])).toMatch(/no-transform/);
      expect(res.headers['x-accel-buffering']).toBe('no');

      const firstEvent = await new Promise<string>((resolve, reject) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          buf += c;
          if (buf.includes('\n\n')) resolve(buf);
        });
        res.on('error', reject);
      });
      const elapsed = Date.now() - t0;
      expect(firstEvent).toContain('event: tick');
      expect(firstEvent).toContain('data: {"n":1}');
      expect(elapsed).toBeLessThan(500);
      // upstream asked for an uncompressed stream
      expect(upstreamRequestHeaders['accept-encoding']).toBe('identity');
    } finally {
      abort();
    }
  });

  it('flushes headers immediately, even before the first event', async () => {
    const quiet = await startUpstream('notifications', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders(); // no body bytes yet
    });
    const app = buildApp({ config: testGatewayConfig({ notifications: quiet.url }), logger: testLogger('gateway') });
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => srv.once('listening', resolve));
    try {
      const t0 = Date.now();
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: (srv.address() as AddressInfo).port, path: '/api/v1/realtime/stream?ticket=x' }, (res) => {
          resolve(res.statusCode ?? 0);
          req.destroy();
        });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(500);
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      await quiet.close();
    }
  });

  it('has no 15 s-style idle timeout: stays open past UPSTREAM_TIMEOUT_MS (200 ms) and keeps delivering', async () => {
    const { res, abort } = await openStream();
    try {
      let events = 0;
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        events += (c.match(/event: tick/g) ?? []).length;
      });
      await new Promise((r) => setTimeout(r, 700));
      expect(events).toBeGreaterThanOrEqual(8);
      expect(res.destroyed).toBe(false);
    } finally {
      abort();
    }
  });

  it('propagates client disconnect by destroying the upstream request', async () => {
    const before = upstreamClosed;
    const { res, abort } = await openStream();
    await new Promise<void>((resolve) => res.once('data', () => resolve()));
    abort();
    const deadline = Date.now() + 2000;
    while (upstreamClosed === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(upstreamClosed).toBeGreaterThan(before);
  });
});
