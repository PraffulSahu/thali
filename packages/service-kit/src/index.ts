/**
 * @thali/service-kit — shared HTTP / auth / data / safety primitives for every Thali service.
 * Testing helpers live in `@thali/service-kit/testing`.
 */
export type { AuthContext, CallerContext, ValidatedRequest, RequestId } from './types/express.js';

export { loadConfig, ConfigError, BaseConfigShape, envBool, envList, envOptionalUrl, envTrustProxy, type BaseConfig } from './config.js';
export { createLogger, REDACT_PATHS, type CreateLoggerOptions, type Logger } from './logger.js';
export { createApp, redisHealthCheck, type CreateAppOptions, type HealthCheck } from './app.js';
export { getKit, type KitContext } from './context.js';
export {
  errorHandler,
  notFoundHandler,
  resolveError,
  sendError,
  shouldExposeInternals,
  GENERIC_5XX_MESSAGES,
  type ResolveErrorOptions,
  zodIssues,
  type ErrorBody,
  type ResolvedError,
  type ValidationIssue,
} from './errors.js';
export { validate, type ValidateSchemas, type Validated, type Validator } from './validate.js';
export {
  requestId,
  requestIdOf,
  currentRequestId,
  runWithRequestId,
  REQUEST_ID_HEADER,
} from './request-id.js';
export { listRoutes, type RouteInfo } from './introspect.js';

export {
  createAuthVerifier,
  revokeSession,
  revocationKeyName,
  ACCESS_TOKEN_ISSUER,
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ALGORITHMS,
  REVOCATION_TTL_SEC,
  CLOCK_TOLERANCE_SEC,
  type AuthVerifier,
  type AuthVerifierOptions,
} from './auth/jwks.js';
export { requireAuth, bearerToken, type RequireAuthOptions } from './auth/require-auth.js';
export { signServiceToken, verifyServiceToken, SERVICE_TOKEN_TTL_SEC } from './auth/service-token.js';
export { requireInternal } from './auth/require-internal.js';
export {
  internalClient,
  UpstreamError,
  type InternalClient,
  type InternalClientOptions,
  type RequestOptions,
} from './http/internal-client.js';

export { connectMongo, mongoHealthCheck, type Connection } from './data/mongo.js';
export { withTransaction, type ClientSession } from './data/transaction.js';
export {
  createRedis,
  getKeyPrefix,
  setKeyPrefix,
  redisKey,
  DEFAULT_REDIS_KEY_PREFIX,
  type CreateRedisOptions,
  type Redis,
} from './redis.js';

export {
  rateLimit,
  consumeRateLimit,
  type RateLimitOptions,
  type RateLimitResult,
  type ConsumeRateLimitOptions,
} from './rate-limit.js';
export {
  idempotency,
  idempotencyModel,
  canonicalJson,
  requestHash,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_COLLECTION,
  IDEMPOTENCY_TTL_SEC,
  type IdempotencyOptions,
  type IdempotencyRecord,
} from './idempotency.js';
export { encryptField, decryptField, isEncryptedField } from './crypto.js';
export { encodeCursor, decodeCursor, cursorFilter, buildPage, PAGE_SORT, type CursorPosition } from './pagination.js';
export {
  createOpenApi,
  toOpenApiPath,
  BEARER_SCHEME,
  SERVICE_TOKEN_SCHEME,
  type OpenApi,
  type OpenApiDocument,
  type KitRouteConfig,
  type CreateOpenApiOptions,
} from './openapi.js';
export { gracefulShutdown, type GracefulShutdownOptions } from './shutdown.js';
