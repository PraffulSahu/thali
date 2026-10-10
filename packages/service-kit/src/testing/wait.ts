/**
 * Poll until a condition holds (deterministic async tests without fixed sleeps).
 */
export interface WaitForOptions {
  /** Default 5000 ms. */
  timeoutMs?: number;
  /** Default 20 ms. */
  intervalMs?: number;
  /** Included in the timeout error. */
  message?: string;
}

/** Resolves once `condition()` returns truthy; rejects with the last error/false after `timeoutMs`. */
export async function waitFor(condition: () => unknown | Promise<unknown>, opts: WaitForOptions = {}): Promise<void> {
  const { timeoutMs = 5000, intervalMs = 20 } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      if (await condition()) return;
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      const why = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`waitFor timed out after ${timeoutMs} ms${opts.message ? ` (${opts.message})` : ''}${why}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
