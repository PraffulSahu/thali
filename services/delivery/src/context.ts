/**
 * Runtime context shared by routes, event handlers, the dispatcher and the simulator.
 * Built once in `index.ts` (real providers) or in tests (fakes + controllable clock).
 */
import type { Connection } from 'mongoose';
import type { Logger } from 'pino';
import { UpstreamError, createDemoGeo, internalClient, type GeoProvider, type Redis, type StorageProvider } from '@thali/service-kit';
import type { Role } from '@thali/contracts';
import type { DeliveryConfig } from './config.js';
import { getModels, type DeliveryModels } from './models/index.js';
import { createSimulator, type Simulator } from './domain/simulator.js';

/** identity `GET /internal/users/:id` (binding shape). */
export interface IdentityUser {
  id: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  roles: Role[];
  status: 'ACTIVE' | 'BLOCKED';
  notificationPrefs: { orderSms: boolean; orderEmail: boolean; marketingSms: boolean; marketingEmail: boolean };
}

export interface IdentityClient {
  /** `GET /internal/users/:id`; null on 404. */
  getUser(id: string): Promise<IdentityUser | null>;
  /** `POST /internal/users/:id/roles {role}` (idempotent). */
  grantRole(id: string, role: 'DELIVERY_PARTNER'): Promise<{ userId: string; roles: Role[] }>;
}

export function createIdentityClient(config: DeliveryConfig): IdentityClient {
  const http = internalClient('identity', config.IDENTITY_URL, { from: 'delivery', secret: config.INTERNAL_SERVICE_SECRET });
  return {
    async getUser(id) {
      try {
        return await http.get<IdentityUser>(`/internal/users/${encodeURIComponent(id)}`);
      } catch (err) {
        if (err instanceof UpstreamError && err.upstreamStatus === 404) return null;
        throw err;
      }
    },
    grantRole(id, role) {
      return http.post<{ userId: string; roles: Role[] }>(`/internal/users/${encodeURIComponent(id)}/roles`, { role });
    },
  };
}

export interface ContextDeps {
  config: DeliveryConfig;
  logger: Logger;
  conn: Connection;
  redis: Redis;
  identity: IdentityClient;
  storage: StorageProvider;
  geo?: GeoProvider;
  clock?: () => Date;
}

export interface DeliveryContext {
  config: DeliveryConfig;
  logger: Logger;
  conn: Connection;
  redis: Redis;
  identity: IdentityClient;
  storage: StorageProvider;
  geo: GeoProvider;
  now: () => Date;
  models: DeliveryModels;
  simulator: Simulator;
}

export function createContext(deps: ContextDeps): DeliveryContext {
  const ctx = {
    config: deps.config,
    logger: deps.logger,
    conn: deps.conn,
    redis: deps.redis,
    identity: deps.identity,
    storage: deps.storage,
    geo: deps.geo ?? createDemoGeo({ roadFactor: deps.config.ROAD_FACTOR, avgSpeedKmph: deps.config.AVG_SPEED_KMPH }),
    now: deps.clock ?? (() => new Date()),
    models: getModels(deps.conn),
  } as DeliveryContext;
  ctx.simulator = createSimulator(ctx);
  return ctx;
}
