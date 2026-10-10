import { ProviderSendError } from '../providers/errors.js';

/** Delay after failed attempt `attempt` (1-based): base * 2^(attempt-1), capped. 30 s, 60 s, 120 s ... */
export function nextDelaySec(attempt: number, baseSec: number, maxSec: number): number {
  const exp = Math.min(Math.max(attempt - 1, 0), 30);
  return Math.min(baseSec * 2 ** exp, maxSec);
}

/** Provider errors say so explicitly; anything unknown (network, bug) is treated as transient. */
export function isRetryable(err: unknown): boolean {
  return err instanceof ProviderSendError ? err.retryable : true;
}

/** Safe, bounded, secret-free description of a failure for `lastError` (never includes message bodies). */
export function describeError(err: unknown): string {
  if (err instanceof ProviderSendError) {
    const parts = [err.provider, err.status ? String(err.status) : null, err.code ? `code ${err.code}` : null].filter(Boolean);
    return `${parts.join(' ')}: ${err.message}`.slice(0, 300);
  }
  return `${err instanceof Error ? err.name : 'Error'}: ${err instanceof Error ? err.message : 'unknown'}`.slice(0, 300);
}
