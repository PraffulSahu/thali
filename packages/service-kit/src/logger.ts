/**
 * pino logger factory with LLD 5.5 redaction.
 */
import { pino, type DestinationStream, type Logger } from 'pino';

/** LLD 5.5 redact paths (single-level wildcards, pino semantics). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.code',
  '*.otp',
  '*.token',
  '*.refreshToken',
  '*.accountNumber',
  '*.totpSecret',
];

export interface CreateLoggerOptions {
  /** Defaults to `process.env.LOG_LEVEL` or `info`. */
  level?: string;
  /** Custom destination (tests). Defaults to stdout. */
  destination?: DestinationStream;
}

export type { Logger };

/** JSON logger with `{ service }` on every line and secrets redacted. */
export function createLogger(service: string, opts: CreateLoggerOptions = {}): Logger {
  const options = {
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service },
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}
