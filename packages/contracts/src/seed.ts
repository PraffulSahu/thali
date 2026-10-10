import { createHash } from 'node:crypto';

/**
 * Deterministic ObjectId-shaped id (24 hex chars) for seed data shared by all services.
 * Node-only: import via `@thali/contracts/seed` (deliberately NOT re-exported from the root
 * index so the browser bundle never pulls in `node:crypto`).
 */
export function seedId(name: string): string {
  return createHash('sha1').update(`thali-seed:${name}`).digest('hex').slice(0, 24);
}
