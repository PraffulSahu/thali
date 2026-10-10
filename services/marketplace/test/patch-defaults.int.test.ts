/**
 * Guard (review fix): no PATCH request body anywhere in the marketplace API may carry a `default` —
 * Zod 4 applies `.default()` inside `.partial()`, so a defaulted field in a PATCH schema silently
 * overwrites stored values on every partial update. Walks every PATCH operation in /openapi.json
 * (resolving $refs) and fails on any `default` keyword.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness('patch_defaults');
});
afterAll(async () => h?.close());

type Json = Record<string, unknown>;

function defaultsIn(node: unknown, doc: Json, path: string, seen = new Set<string>()): string[] {
  if (!node || typeof node !== 'object') return [];
  const obj = node as Json;
  if (typeof obj.$ref === 'string') {
    if (seen.has(obj.$ref)) return [];
    seen.add(obj.$ref);
    const target = (obj.$ref as string).replace('#/', '').split('/').reduce<unknown>((o, k) => (o as Json)?.[k], doc);
    return defaultsIn(target, doc, `${path}->${obj.$ref}`, seen);
  }
  const found: string[] = 'default' in obj ? [path] : [];
  for (const [k, v] of Object.entries(obj)) if (k !== 'default') found.push(...defaultsIn(v, doc, `${path}.${k}`, seen));
  return found;
}

describe('PATCH bodies carry no defaults', () => {
  it('every PATCH request schema is default-free (create schemas keep theirs)', async () => {
    const doc = (await request(h.app).get('/openapi.json')).body as Json;
    const paths = doc.paths as Record<string, Record<string, Json>>;
    const patches = Object.entries(paths).filter(([, ops]) => ops.patch);
    expect(patches.length).toBeGreaterThanOrEqual(8);
    const offenders = patches.flatMap(([p, ops]) => defaultsIn(ops.patch!.requestBody, doc, `PATCH ${p}`));
    expect(offenders).toEqual([]);
    // positive control: the coupon create body does document its defaults
    const create = paths['/api/v1/admin/marketplace/coupons']!.post!.requestBody;
    expect(defaultsIn(create, doc, 'POST coupons').length).toBeGreaterThan(0);
  });
});
