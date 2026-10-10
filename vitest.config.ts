import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// THALI_TEST_KIND: unit -> excludes *.int.test.ts, int -> only *.int.test.ts, otherwise all.
const kind = process.env.THALI_TEST_KIND ?? 'all';
const include = kind === 'int' ? ['test/**/*.int.test.ts'] : ['test/**/*.test.{ts,tsx}'];
const exclude = kind === 'unit' ? ['**/node_modules/**', '**/dist/**', '**/*.int.test.ts'] : ['**/node_modules/**', '**/dist/**'];

const workspaces = [
  ['@thali/contracts', 'packages/contracts', 'node'],
  ['@thali/pricing', 'packages/pricing', 'node'],
  ['@thali/service-kit', 'packages/service-kit', 'node'],
  ['@thali/gateway', 'services/gateway', 'node'],
  ['@thali/identity', 'services/identity', 'node'],
  ['@thali/marketplace', 'services/marketplace', 'node'],
  ['@thali/orders', 'services/orders', 'node'],
  ['@thali/payments', 'services/payments', 'node'],
  ['@thali/delivery', 'services/delivery', 'node'],
  ['@thali/notifications', 'services/notifications', 'node'],
  ['@thali/web', 'apps/web', 'jsdom'],
] as const;

export default defineConfig({
  // Resolve workspace packages from source so tests never need a prebuild.
  resolve: {
    alias: [
      { find: /^@thali\/contracts$/, replacement: p('./packages/contracts/src/index.ts') },
      { find: /^@thali\/contracts\/(.+)$/, replacement: p('./packages/contracts/src/$1') },
      { find: /^@thali\/pricing$/, replacement: p('./packages/pricing/src/index.ts') },
      { find: /^@thali\/pricing\/(.+)$/, replacement: p('./packages/pricing/src/$1') },
      { find: /^@thali\/service-kit$/, replacement: p('./packages/service-kit/src/index.ts') },
      { find: /^@thali\/service-kit\/testing$/, replacement: p('./packages/service-kit/src/testing/index.ts') },
      { find: /^@thali\/service-kit\/(.+)$/, replacement: p('./packages/service-kit/src/$1') },
    ],
  },
  test: {
    projects: workspaces.map(([name, dir, environment]) => ({
      extends: true as const,
      test: {
        name,
        root: p(`./${dir}`),
        environment,
        include,
        exclude,
        testTimeout: kind === 'unit' ? 10_000 : 30_000,
        // Integration hooks create Mongo databases/indexes, Redis consumers and app instances; on a loaded dev VM
        // with several suites in parallel these can take well over 30 s (*.int.test.ts run in 'int' and 'all').
        hookTimeout: kind === 'unit' ? 10_000 : 120_000,
      },
    })),
  },
});
