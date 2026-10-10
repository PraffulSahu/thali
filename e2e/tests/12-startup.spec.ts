/**
 * Flow 12: the application starts from the documented setup without undocumented manual fixes.
 * The stack under test was started with the README commands (`npm run e2e` = stack:up + seed + playwright).
 * Checks: every compose container healthy (one-shot init jobs exited 0), gateway readiness + /api/v1/meta,
 * the web app served by nginx in demo mode, and the README documents exactly those commands.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATEWAY_URL, REPO_ROOT, WEB_URL } from '../fixtures/env.js';
import { composePs } from '../fixtures/stack.js';

const LONG_RUNNING = ['mongo', 'redis', 'minio', 'mailpit', 'identity', 'marketplace', 'orders', 'payments', 'delivery', 'notifications', 'gateway', 'web'];
const ONE_SHOT = ['mongo-init', 'minio-init'];

test('docker compose stack is healthy', () => {
  const ps = composePs();
  const by = new Map(ps.map((c) => [c.Service, c]));
  for (const svc of LONG_RUNNING) {
    const c = by.get(svc);
    expect(c, `${svc} container exists`).toBeTruthy();
    expect(c!.State, `${svc} state (${c!.Status})`).toBe('running');
    expect(c!.Health, `${svc} health (${c!.Status})`).toBe('healthy');
  }
  for (const svc of ONE_SHOT) {
    const c = by.get(svc);
    if (!c) continue; // removed after completion is fine
    expect(c.State, `${svc} state`).toBe('exited');
    expect(c.ExitCode, `${svc} exit code`).toBe(0);
  }
  const unexpected = ps.filter((c) => !LONG_RUNNING.includes(c.Service) && !ONE_SHOT.includes(c.Service) && c.State !== 'exited');
  expect(unexpected.filter((c) => c.Health && c.Health !== 'healthy').map((c) => `${c.Service}:${c.Health}`)).toEqual([]);
});

test('gateway ready, /api/v1/meta 200 in demo mode, web app served', async ({ request, page }) => {
  const ready = await request.get(`${GATEWAY_URL}/health/ready`);
  expect(ready.status()).toBe(200);
  expect((await ready.json()).status).toBe('ok');

  for (const base of [GATEWAY_URL, WEB_URL]) {
    const meta = await request.get(`${base}/api/v1/meta`);
    expect(meta.status(), `${base}/api/v1/meta`).toBe(200);
    const body = await meta.json();
    expect(body).toMatchObject({ mode: 'demo', brand: 'Thali', currency: 'INR', timezone: 'Asia/Kolkata' });
    expect(Object.keys(body.providers).sort()).toEqual(['email', 'maps', 'payment', 'sms', 'storage']);
  }

  await page.goto('/');
  await expect(page.getByText('DEMO MODE')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Where should we deliver?' })).toBeVisible();
});

test('README documents the commands used to start the stack', () => {
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  for (const cmd of ['cp .env.example .env', 'npm ci', 'npm run stack:up', 'npm run seed', 'npm run e2e']) {
    expect(readme, `README mentions "${cmd}"`).toContain(cmd);
  }
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  expect(pkg.scripts['stack:up']).toContain('docker compose up');
  expect(pkg.scripts.e2e).toMatch(/stack:up.*seed.*e2e/);
});
