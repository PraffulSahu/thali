/**
 * MongoDB connection (one database per service: `thali_<service>`).
 */
import mongoose, { type Connection, type ConnectOptions } from 'mongoose';

export type { Connection };

/** Open a dedicated mongoose connection to `dbName` and wait until it is ready. */
export async function connectMongo(uri: string, dbName: string, opts: ConnectOptions = {}): Promise<Connection> {
  const conn = mongoose.createConnection(uri, {
    dbName,
    serverSelectionTimeoutMS: 10_000,
    ...opts,
  });
  return conn.asPromise();
}

/** Health check for `createApp({ healthChecks: { mongo: mongoHealthCheck(conn) } })`. */
export function mongoHealthCheck(conn: Connection): () => Promise<void> {
  return async () => {
    if (!conn.db) throw new Error('mongo not connected');
    await conn.db.admin().ping();
  };
}
