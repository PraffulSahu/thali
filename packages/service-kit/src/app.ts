/**
 * `createApp` — the Express 5 app factory every service uses (LLD 2.3).
 *
 * Order: x-powered-by off → trust proxy → requestId (+ async context) → pino-http → helmet → CORS
 * (`CORS_ORIGINS`, credentials) → JSON/urlencoded body (limit 1 MB, raw bytes on `req.rawBody`;
 * skipped with `bodyParser: false`) →
 * cookie-parser → kit routes (`/health/live`, `/health/ready`, `/openapi.json`,
 * `GET /internal/routes` [requireInternal]) → `routes(app)` → `/docs` (Swagger UI, only when
 * `DOCS_ENABLED`) → 404 → error handler.
 */
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import swaggerUi from 'swagger-ui-express';
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { createAuthVerifier, type AuthVerifier } from './auth/jwks.js';
import { requireInternal } from './auth/require-internal.js';
import type { BaseConfig } from './config.js';
import type { KitContext } from './context.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { listRoutes } from './introspect.js';
import type { OpenApi, OpenApiDocument } from './openapi.js';
import type { Redis } from './redis.js';
import { requestId, requestIdOf } from './request-id.js';

/** A readiness check: resolve (any value except `false`) = up; reject / `false` / timeout = down. */
export type HealthCheck = () => Promise<unknown>;

export interface CreateAppOptions {
  config: BaseConfig;
  logger: Logger;
  /** Register the service's routes/routers on `app`. */
  routes: (app: Express) => void;
  /** `createOpenApi(...)` result (preferred) or a bare registry. Served at `/openapi.json` and `/docs`. */
  openapi?: OpenApi | OpenAPIRegistry;
  /** `/health/ready` checks, e.g. `{ mongo: mongoHealthCheck(conn), redis: redisHealthCheck(redis) }`. */
  healthChecks?: Record<string, HealthCheck>;
  /** Per-check timeout, default 2000 ms. */
  healthCheckTimeoutMs?: number;
  /** Access-token verifier for `requireAuth`. Default: `createAuthVerifier({ jwksUrl: config.JWKS_URL, redis })`. */
  auth?: AuthVerifier;
  /** Redis for the default verifier's revocation check. */
  redis?: Redis;
  /** JSON / urlencoded body limit, default `1mb`. */
  bodyLimit?: string;
  /**
   * Default true. `false` skips JSON/urlencoded parsing entirely so request streams reach handlers
   * untouched (gateway raw passthrough); mount `express.json()` on specific routes if needed.
   */
  bodyParser?: boolean;
  /** Express `trust proxy`, default `'loopback, linklocal, uniquelocal'` (private networks). */
  trustProxy?: boolean | number | string;
}

function documentOf(openapi: OpenApi | OpenAPIRegistry, service: string): OpenApiDocument {
  if (openapi instanceof OpenAPIRegistry) {
    return new OpenApiGeneratorV31(openapi.definitions).generateDocument({
      openapi: '3.1.0',
      info: { title: `Thali ${service} API`, version: '1.0.0' },
    });
  }
  return openapi.document();
}

async function runCheck(check: HealthCheck, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([check().then((v) => v !== false), timeout]);
    return result;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function createApp(opts: CreateAppOptions): Express {
  const { config, logger } = opts;
  const production = config.APP_MODE === 'production';
  const app = express();

  const auth =
    opts.auth ??
    (config.JWKS_URL && opts.redis ? createAuthVerifier({ jwksUrl: config.JWKS_URL, redis: opts.redis }) : undefined);
  const kit: KitContext = { config, logger, auth, redis: opts.redis };
  app.locals.kit = kit;

  app.disable('x-powered-by');
  app.set('trust proxy', opts.trustProxy ?? 'loopback, linklocal, uniquelocal');

  app.use(requestId());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as unknown as express.Request).id as string,
      customProps: (req) => ({ reqId: requestIdOf(req as unknown as express.Request) }),
      autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/health/') },
      quietReqLogger: true,
    }),
  );
  app.use((req, _res, next) => {
    req.valid = {};
    next();
  });
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGINS.length ? config.CORS_ORIGINS : false, credentials: true }));
  const captureRaw = (req: express.Request, _res: unknown, buf: Buffer) => {
    req.rawBody = buf;
  };
  const limit = opts.bodyLimit ?? '1mb';
  if (opts.bodyParser !== false) {
    app.use(express.json({ limit, verify: captureRaw as never }));
    app.use(express.urlencoded({ extended: false, limit, verify: captureRaw as never }));
  }
  app.use(cookieParser());

  // --- kit routes ---
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  const checks = Object.entries(opts.healthChecks ?? {});
  const timeoutMs = opts.healthCheckTimeoutMs ?? 2000;
  app.get('/health/ready', async (_req, res) => {
    const results = await Promise.all(checks.map(async ([name, check]) => [name, await runCheck(check, timeoutMs)] as const));
    const ok = results.every(([, up]) => up);
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'unavailable',
      checks: Object.fromEntries(results.map(([name, up]) => [name, up ? 'up' : 'down'])),
    });
  });

  let cachedDoc: OpenApiDocument | undefined;
  const getDoc = () => (opts.openapi ? (cachedDoc ??= documentOf(opts.openapi, config.SERVICE_NAME)) : undefined);
  app.get('/openapi.json', (_req, res) => {
    const doc = getDoc();
    if (!doc) {
      res.json({ openapi: '3.1.0', info: { title: `Thali ${config.SERVICE_NAME} API`, version: '1.0.0' }, paths: {} });
      return;
    }
    res.json(doc);
  });
  app.get('/internal/routes', requireInternal(), (_req, res) => {
    res.json(listRoutes(app));
  });

  // --- service routes ---
  opts.routes(app);

  if (config.DOCS_ENABLED) {
    const doc = getDoc() ?? { openapi: '3.1.0', info: { title: config.SERVICE_NAME, version: '1.0.0' }, paths: {} };
    app.use('/docs', swaggerUi.serveFiles(doc as never), swaggerUi.setup(doc as never) as RequestHandler);
  }

  app.use(notFoundHandler());
  app.use(errorHandler({ logger, production }));
  return app;
}

/** Health check for Redis (`PING`). */
export function redisHealthCheck(redis: Redis): HealthCheck {
  return () => redis.ping();
}
