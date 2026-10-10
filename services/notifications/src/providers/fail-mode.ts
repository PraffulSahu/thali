/**
 * Demo-only outage switch (Task 22 outage tests): when on, the MOCK providers throw a retryable 503.
 * Stored in Redis so every instance agrees; auto-expires so a forgotten switch cannot leave a demo broken.
 */
import { redisKey, type Redis } from '@thali/service-kit';

export interface FailModeState {
  sms: boolean;
  email: boolean;
}
export interface FailModeReader {
  get(): Promise<FailModeState>;
}
export interface FailMode extends FailModeReader {
  set(state: FailModeState): Promise<FailModeState>;
}

export const FAIL_MODE_TTL_SEC = 3600;

export function createFailMode(redis: Redis): FailMode {
  const key = () => redisKey(redis, 'demo:fail-mode');
  return {
    async get() {
      try {
        const raw = await redis.get(key());
        if (!raw) return { sms: false, email: false };
        const v = JSON.parse(raw) as Partial<FailModeState>;
        return { sms: v.sms === true, email: v.email === true };
      } catch {
        return { sms: false, email: false };
      }
    },
    async set(state) {
      const next = { sms: state.sms, email: state.email };
      if (!next.sms && !next.email) await redis.del(key());
      else await redis.set(key(), JSON.stringify(next), 'EX', FAIL_MODE_TTL_SEC);
      return next;
    },
  };
}
