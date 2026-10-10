/**
 * Minimal HTTP helper for third-party providers: timeout via AbortSignal, JSON parsing, typed error.
 * Uses `globalThis.fetch` at call time (tests stub it with `vi.stubGlobal('fetch', ...)`).
 * Never log request URLs/headers here: they can carry API keys.
 */
export class ProviderError extends Error {
  readonly provider: string;
  /** HTTP status when the provider answered; undefined for network errors/timeouts. */
  readonly status?: number;
  constructor(provider: string, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(`${provider}: ${message}`, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = opts.status;
  }
}

export interface ProviderFetchOptions extends Omit<RequestInit, 'signal'> {
  /** Default 5000 ms. */
  timeoutMs?: number;
}

/** fetch + timeout + JSON; throws `ProviderError` on network error, timeout, non-2xx or invalid JSON. */
export async function fetchJson<T = unknown>(provider: string, url: string, opts: ProviderFetchOptions = {}): Promise<T> {
  const { timeoutMs = 5000, ...init } = opts;
  let res: Response;
  try {
    res = await globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? `timed out after ${timeoutMs} ms` : 'network error';
    throw new ProviderError(provider, reason, { cause: err });
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new ProviderError(provider, `HTTP ${res.status}`, { status: res.status });
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch (err) {
    throw new ProviderError(provider, 'invalid JSON response', { status: res.status, cause: err });
  }
}
