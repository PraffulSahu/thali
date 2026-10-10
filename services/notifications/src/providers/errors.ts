/** Error raised by SMS/email providers. `retryable` drives the retry/DEAD decision in the dispatcher. */
export class ProviderSendError extends Error {
  readonly provider: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly code?: string;

  constructor(provider: string, message: string, opts: { retryable: boolean; status?: number; code?: string | number; cause?: unknown }) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ProviderSendError';
    this.provider = provider;
    this.retryable = opts.retryable;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.code !== undefined) this.code = String(opts.code);
  }
}

/** HTTP statuses worth retrying; every other 4xx is a permanent rejection of this message. */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

/** Provider error text can echo recipients; keep `lastError` free of phone numbers / emails / urls with tokens. */
export function scrubMessage(text: unknown, max = 200): string {
  const s = typeof text === 'string' ? text : '';
  return s
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
    .replace(/https?:\/\/\S+/g, '[url]')
    .slice(0, max);
}
