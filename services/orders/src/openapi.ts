/** Orders OpenAPI document: service-kit ops routes + every route module's registrations. */
import { createOpenApi, registerOpsRoutes, type OpenApi } from '@thali/service-kit';
import { routeModules, type RouteModule } from './routes/index.js';

export function buildOpenApi(modules: RouteModule[] = routeModules): OpenApi {
  const openapi = createOpenApi('orders', {
    description:
      'Carts (guest + user), multi-restaurant checkout saga (one child order per restaurant, delivered separately), ' +
      'payment outcomes and order lifecycle. Money is integer paise; times are UTC ISO-8601.',
  });
  registerOpsRoutes(openapi);
  for (const m of modules) m.openapi(openapi);
  return openapi;
}
