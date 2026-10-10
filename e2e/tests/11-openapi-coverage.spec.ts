/**
 * Flow 11: all implemented endpoints are documented.
 * For every service, the routes actually registered on its Express app (service-kit `GET /internal/routes`,
 * called inside the compose network with a service token) must all appear in the service's own
 * `/openapi.json`, and every public route must appear in the spec the gateway publishes at
 * `/api/docs/specs/<svc>.json` (which hides /internal and /health by design). The Swagger UI must load.
 */
import { expect, test } from '@playwright/test';
import { GATEWAY_URL } from '../fixtures/env.js';
import { introspectService, type RouteInfo } from '../fixtures/stack.js';

const SERVICES = ['identity', 'marketplace', 'orders', 'payments', 'delivery', 'notifications', 'gateway'] as const;
/** Routes the gateway intentionally leaves out of the public specs (docs.ts HIDDEN_PATH). */
const HIDDEN = /^\/(internal|health)(\/|$)|^\/openapi\.json$/;
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** Express `/:id/x` -> OpenAPI `/{id}/x`. */
const toOpenApi = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

function operations(spec: { paths: Record<string, Record<string, unknown>> }): Set<string> {
  const out = new Set<string>();
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const m of Object.keys(ops)) if (METHODS.includes(m)) out.add(`${m.toUpperCase()} ${path}`);
  }
  return out;
}

const key = (r: RouteInfo) => `${r.method} ${toOpenApi(r.path)}`;

for (const svc of SERVICES) {
  test(`${svc}: every registered route is in its OpenAPI spec`, async ({ request }) => {
    const { routes, spec } = introspectService(svc);
    expect(routes.length, 'routes registered').toBeGreaterThan(3);
    const real = routes.filter((r) => r.method !== 'ALL' && r.method !== 'HEAD' && r.method !== 'OPTIONS');

    // 1) the service's own spec documents every route (internal ones included)
    const own = operations(spec);
    const undocumented = real.map(key).filter((k) => !own.has(k));
    expect(undocumented, `${svc}: routes missing from ${svc}/openapi.json`).toEqual([]);

    // 2) the gateway-published spec documents every public route
    const res = await request.get(`${GATEWAY_URL}/api/docs/specs/${svc}.json`);
    expect(res.status()).toBe(200);
    const published = operations(await res.json());
    const publicRoutes = real.filter((r) => svc === 'gateway' || !HIDDEN.test(r.path));
    const missing = publicRoutes.map(key).filter((k) => !published.has(k));
    expect(missing, `${svc}: public routes missing from /api/docs/specs/${svc}.json`).toEqual([]);

    // 3) no documented operation without a real route (stale docs)
    const routeKeys = new Set(real.map(key));
    const stale = [...own].filter((k) => !routeKeys.has(k));
    expect(stale, `${svc}: documented but not registered`).toEqual([]);

    // 4) every operation declares its responses
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [m, op] of Object.entries(ops)) {
        if (!METHODS.includes(m)) continue;
        expect(Object.keys((op as { responses?: object }).responses ?? {}), `${m.toUpperCase()} ${path} responses`).not.toHaveLength(0);
      }
    }
  });
}

test('Swagger UI at the gateway lists every service spec', async ({ page }) => {
  await page.goto(`${GATEWAY_URL}/api/docs/`);
  await expect(page).toHaveTitle(/Thali API/);
  for (const svc of SERVICES) {
    const r = await page.request.get(`${GATEWAY_URL}/api/docs/specs/${svc}.json`);
    expect(r.status(), `${svc} spec`).toBe(200);
    const body = await r.json();
    expect(body.openapi).toMatch(/^3\./);
    expect(Object.keys(body.paths).length, `${svc} paths`).toBeGreaterThan(0);
  }
  await expect(page.locator('section.swagger-ui .opblock').first()).toBeVisible(); // operations rendered
});
