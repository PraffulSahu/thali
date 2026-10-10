/**
 * Classify "infrastructure unavailable" errors (Mongo / Redis connectivity), as opposed to errors
 * caused by the work itself. The stream consumer does not count these as handler attempts: it pauses
 * and probes until the dependency is back, so an outage never dead-letters healthy events.
 *
 * Deliberately narrow: only Mongo driver / mongoose / ioredis signatures. Generic socket errors
 * (ECONNREFUSED from `fetch` to another service or a provider) are NOT infra here — those are
 * handler failures and count towards maxAttempts.
 */
const MONGO_INFRA_NAMES = new Set([
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoServerSelectionError',
  'MongoTopologyClosedError',
  'MongoNotConnectedError',
  'MongoPoolClearedError',
  'MongoExpiredSessionError',
]);
const MONGO_INFRA_LABELS = ['TransientTransactionError', 'UnknownTransactionCommitResult', 'RetryableWriteError', 'ResetPool'];
const REDIS_INFRA_NAMES = new Set(['MaxRetriesPerRequestError']);
const MESSAGE_PATTERNS = [
  /buffering timed out after/i, // mongoose operation buffering while disconnected
  /Client must be connected/i,
  /^Connection is closed\.?$/i, // ioredis
  /Stream isn't writeable/i, // ioredis, offline queue disabled
  /Reached the max retries per request limit/i, // ioredis
];

interface ErrorLike {
  name?: string;
  message?: string;
  code?: unknown;
  errorLabels?: unknown;
  errorLabelSet?: unknown;
  hasErrorLabel?: (label: string) => boolean;
  cause?: unknown;
}

function hasLabel(e: ErrorLike, label: string): boolean {
  try {
    if (typeof e.hasErrorLabel === 'function' && e.hasErrorLabel(label)) return true;
  } catch {
    // ignore
  }
  if (Array.isArray(e.errorLabels) && e.errorLabels.includes(label)) return true;
  if (e.errorLabelSet instanceof Set && e.errorLabelSet.has(label)) return true;
  return false;
}

/** True for Mongo/Redis connectivity and transient-transaction errors (checks `cause` chains too). */
export function isInfraError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 5) return false;
  const e = err as ErrorLike;
  if (e.name && (MONGO_INFRA_NAMES.has(e.name) || REDIS_INFRA_NAMES.has(e.name))) return true;
  if (MONGO_INFRA_LABELS.some((l) => hasLabel(e, l))) return true;
  if (typeof e.message === 'string' && MESSAGE_PATTERNS.some((re) => re.test(e.message!))) return true;
  return isInfraError(e.cause, depth + 1);
}
