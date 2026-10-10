import type { Connection } from 'mongoose';
import { initEventCollections } from '@thali/service-kit';
import { models } from './models/index.js';

/** Create collections + indexes before serving (transactions must not race collection creation). */
export async function initIdentityDb(conn: Connection): Promise<void> {
  await initEventCollections(conn);
  await Promise.all(Object.values(models(conn)).map((m) => m.init()));
}
