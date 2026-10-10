/**
 * E2E suite for the 12 completion flows (context.md §17 / PRD §9) against the full Docker stack in demo mode.
 *
 *   npm run e2e                      # stack:up + seed + playwright test (root script)
 *   npm test -w @thali/e2e           # against an already running + seeded stack
 *   npx playwright test tests/06-07-delivery-tracking.spec.ts   (from e2e/)
 *
 * Serial on purpose: the flows share the demo phones (OTP cooldowns), the demo partner and the seeded
 * restaurants' order boards.
 */
import { defineConfig, devices } from '@playwright/test';
import { WEB_URL } from './fixtures/env.js';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: WEB_URL,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
