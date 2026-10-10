import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startScheduler, type SchedulerHandle } from '@thali/service-kit';
import { createTestRedis, testLogger, waitFor, type TestRedis } from '@thali/service-kit/testing';

let tr: TestRedis;
const handles: SchedulerHandle[] = [];

beforeAll(async () => {
  tr = await createTestRedis();
});

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()));
});

afterAll(async () => {
  await tr.cleanup();
});

function schedule(name: string, intervalMs: number, run: () => Promise<void>): SchedulerHandle {
  const h = startScheduler({ redis: tr.redis, name, intervalMs, run, logger: testLogger() });
  handles.push(h);
  return h;
}

describe('startScheduler', () => {
  it('two schedulers with the same name: only the lock holder runs, once per interval', async () => {
    const runs: string[] = [];
    let active = 0;
    let maxActive = 0;
    const make = (who: string) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      runs.push(who);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    };
    const t0 = Date.now();
    const a = schedule('sweep-a', 200, make('a'));
    const b = schedule('sweep-a', 200, make('b'));
    await waitFor(() => runs.length >= 5, { timeoutMs: 5000 });
    const elapsed = Date.now() - t0;
    await Promise.all([a.stop(), b.stop()]);
    handles.length = 0;

    expect(maxActive).toBe(1);
    expect(new Set(runs).size).toBe(1); // a single leader did every run
    expect(runs.length).toBeLessThanOrEqual(Math.ceil(elapsed / 200) + 1);
  });

  it('uses SET lock:<name> <instanceId> NX PX <interval*3> and releases on stop', async () => {
    const h = schedule('locked', 300, async () => undefined);
    await waitFor(() => h.isLeader(), { timeoutMs: 2000 });
    const key = `${tr.prefix}lock:locked`;
    expect(await tr.redis.get(key)).toBe(h.instanceId);
    const ttl = await tr.redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900);
    await h.stop();
    expect(await tr.redis.get(key)).toBeNull();
  });

  it('never overlaps runs even when run is slower than the lock TTL (renewal by compare-and-set)', async () => {
    let active = 0;
    let maxActive = 0;
    const runs: string[] = [];
    const slow = (who: string) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      runs.push(who);
      await new Promise((r) => setTimeout(r, 450)); // > 3 * 100 ms lock TTL
      active -= 1;
    };
    schedule('slow', 100, slow('a'));
    schedule('slow', 100, slow('b'));
    await waitFor(() => runs.length >= 3, { timeoutMs: 5000 });
    expect(maxActive).toBe(1);
    expect(new Set(runs).size).toBe(1);
  });

  it('logs errors from run and keeps scheduling', async () => {
    let calls = 0;
    schedule('flaky', 50, async () => {
      calls += 1;
      throw new Error('sweeper failed');
    });
    await waitFor(() => calls >= 3, { timeoutMs: 3000 });
  });

  it('a standby takes over after the leader stops', async () => {
    const runs: string[] = [];
    const a = schedule('handover', 100, async () => void runs.push('a'));
    await waitFor(() => runs.includes('a'), { timeoutMs: 2000 });
    const b = schedule('handover', 100, async () => void runs.push('b'));
    await a.stop();
    await waitFor(() => runs.includes('b'), { timeoutMs: 2000 });
    expect(b.isLeader()).toBe(true);
  });
});
