/** Marketplace OpenAPI document: ops routes + every route module's registrations. */
import { createOpenApi, registerOpsRoutes, type OpenApi } from '@thali/service-kit';
import type { RouteModule } from './context.js';
import { routeModules } from './routes/index.js';

export function buildOpenApi(modules: RouteModule[] = routeModules): OpenApi {
  const api = createOpenApi('marketplace', {
    description:
      'Restaurant onboarding (business-email verification + admin approval), menus, store controls, service areas, catalog, ' +
      'and public discovery/search/serviceability. Money in integer paise; times ISO-8601 UTC; hours in Asia/Kolkata.',
  });
  registerOpsRoutes(api);
  for (const m of modules) m.openapi(api);
  return api;
}
