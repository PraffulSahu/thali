/**
 * Mongo transactions. Uses mongoose `Connection#transaction`, which runs the driver's
 * `withTransaction` (retries the whole callback on `TransientTransactionError` and the commit on
 * `UnknownTransactionCommitResult`) and resets mongoose document state between attempts.
 *
 * Callbacks MUST be safe to re-run: pass `{ session }` to every operation and keep side effects
 * outside Mongo (HTTP calls, Redis publishes) out of the callback — use the outbox instead.
 */
import type { ClientSession, Connection, mongo } from 'mongoose';

type TransactionOptions = mongo.TransactionOptions;

export type { ClientSession };

const DEFAULT_TXN_OPTIONS: TransactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
};

export async function withTransaction<T>(
  conn: Connection,
  fn: (session: ClientSession) => Promise<T>,
  options: TransactionOptions = DEFAULT_TXN_OPTIONS,
): Promise<T> {
  return conn.transaction(fn, options);
}
