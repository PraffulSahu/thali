import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('runs', () => {
    expect(1).toBe(1);
  });

  it('resolves workspace packages via the vitest src aliases', async () => {
    await expect(import('@thali/contracts')).resolves.toBeDefined();
    await expect(import('@thali/service-kit')).resolves.toBeDefined();
    await expect(import('@thali/service-kit/testing')).resolves.toBeDefined();
  });
});
