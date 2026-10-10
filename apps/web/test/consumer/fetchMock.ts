/**
 * Tiny fetch router for consumer tests: `mockApi({ 'GET /cart': cart, 'POST /checkouts': (req) => [201, body] })`.
 * Keys are `METHOD /path` relative to /api/v1 (query string ignored). A handler value is either a JSON body
 * (status 200), a `[status, body]` tuple, or a function returning either. Unmatched calls -> 404 envelope.
 */
import { vi } from 'vitest';

export interface RecordedCall {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Result = unknown | [number, unknown];
type Handler = Result | ((call: RecordedCall) => Result | Promise<Result>);

export function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, details, requestId: 'req_test' } };
}

export function mockApi(routes: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = u.pathname.replace(/^\/api\/v1/, '');
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = { method, path, url, headers, body };
    calls.push(call);
    const handler = routes[`${method} ${path}`];
    let result: Result;
    if (handler === undefined) result = [404, errorBody('NOT_FOUND', `No mock for ${method} ${path}`)];
    else result = typeof handler === 'function' ? await (handler as (c: RecordedCall) => Result)(call) : handler;
    const [status, payload] = Array.isArray(result) && result.length === 2 && typeof result[0] === 'number' ? (result as [number, unknown]) : [200, result];
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    fetchMock,
    callsTo: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path),
  };
}
