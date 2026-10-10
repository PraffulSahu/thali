/**
 * Isolated Mongo database per test file (safe for parallel runs across packages).
 */
import { randomBytes } from 'node:crypto';
import { connectMongo, type Connection } from '../data/mongo.js';

export const TEST_MONGO_URI =
  process.env.TEST_MONGO_URI ?? 'mongodb://localhost:27018/?replicaSet=rs0&directConnection=true';

export interface TestDb {
  uri: string;
  dbName: string;
  conn: Connection;
  /** Drop the database and close the connection. */
  drop(): Promise<void>;
}

/** Connect to a fresh database `test_<prefix>_<random>` on the infra replica set. */
export async function createTestDb(prefix: string): Promise<TestDb> {
  const safe = prefix.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40);
  const dbName = `test_${safe}_${randomBytes(6).toString('hex')}`;
  const conn = await connectMongo(TEST_MONGO_URI, dbName, { serverSelectionTimeoutMS: 5000 });
  return {
    uri: TEST_MONGO_URI,
    dbName,
    conn,
    async drop() {
      try {
        await conn.dropDatabase();
      } finally {
        await conn.close();
      }
    },
  };
}
