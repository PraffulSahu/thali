/**
 * Graceful shutdown: on SIGTERM/SIGINT (or `shutdown()`), stop accepting connections, close idle
 * keep-alive sockets, run `closers` sequentially (e.g. stop relay/consumers → close Redis → close
 * Mongo), then exit 0 (1 if any closer failed). A hard timeout (default 10 s) forces exit 1.
 * Concurrent calls share one shutdown.
 */
import type { Server } from 'node:http';
import type { Logger } from 'pino';

export interface GracefulShutdownOptions {
  server: Server;
  logger: Logger;
  closers?: (() => Promise<void>)[];
  timeoutMs?: number;
  /** Signals to trap; default `['SIGTERM', 'SIGINT']`. Pass `[]` in tests. */
  signals?: NodeJS.Signals[];
  /** Default `process.exit`. */
  exit?: (code: number) => void;
}

export function gracefulShutdown(opts: GracefulShutdownOptions): { shutdown: (reason?: string) => Promise<void> } {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let running: Promise<void> | undefined;

  const shutdown = (reason = 'shutdown') => {
    running ??= (async () => {
      opts.logger.info({ reason }, 'shutting down');
      const timer = setTimeout(() => {
        opts.logger.error('shutdown timed out; forcing exit');
        exit(1);
      }, opts.timeoutMs ?? 10_000);
      timer.unref();

      let failed = false;
      await new Promise<void>((resolve) => {
        if (!opts.server.listening) return resolve();
        opts.server.close(() => resolve());
        opts.server.closeIdleConnections?.();
      });
      for (const close of opts.closers ?? []) {
        try {
          await close();
        } catch (err) {
          failed = true;
          opts.logger.error({ err }, 'closer failed during shutdown');
        }
      }
      clearTimeout(timer);
      opts.logger.info('shutdown complete');
      exit(failed ? 1 : 0);
    })();
    return running;
  };

  for (const sig of opts.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[])) {
    process.once(sig, () => void shutdown(sig));
  }
  return { shutdown };
}
