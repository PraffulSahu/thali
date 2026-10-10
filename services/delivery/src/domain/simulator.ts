/**
 * DEMO-ONLY location simulator (controller ruling): emits pings flagged `simulated: true` along a
 * straight line pickup → drop in 10 steps. It never changes job state (no state-machine rows),
 * never touches the partner's real location (dispatch is unaffected), and is reachable only via an
 * admin route that returns 404 unless APP_MODE=demo (context §10: never simulate in live mode).
 */
import type { DeliveryContext } from '../context.js';
import { ACTIVE_JOB_STATUSES, type JobLean } from '../models/delivery-job.js';
import { remainingEta } from './eta.js';
import { lerp, toLatLng, toPoint } from './geo.js';
import { publishLocation } from './tracking.js';

export const SIMULATION_STEPS = 10;

export interface Simulator {
  /** Start (or restart) a simulation for an active job. */
  start(job: JobLean): { steps: number; stepMs: number };
  isRunning(jobId: string): boolean;
  stopAll(): Promise<void>;
}

export function createSimulator(ctx: DeliveryContext): Simulator {
  const running = new Map<string, { timer: NodeJS.Timeout; inFlight: Promise<void> }>();

  async function step(job: JobLean, i: number): Promise<boolean> {
    const fresh = await ctx.models.Job.findById(job._id).lean<JobLean>();
    if (!fresh || !(ACTIVE_JOB_STATUSES as readonly string[]).includes(fresh.status)) return false;
    const pos = lerp(toLatLng(job.pickup.location), toLatLng(job.drop.location), i / SIMULATION_STEPS);
    const at = ctx.now();
    const point = toPoint(pos);
    await ctx.models.Job.updateOne(
      { _id: job._id, status: { $in: ACTIVE_JOB_STATUSES } },
      { $set: { lastLocation: point, lastLocationAt: at, locationSimulated: true } },
    );
    await ctx.models.LocationPing.create({ partnerId: job.partnerId ?? null, jobId: job._id, location: point, accuracyM: null, simulated: true, at });
    const eta = await remainingEta(ctx, fresh, { location: pos });
    await publishLocation(ctx, job.customerUserId, { childOrderId: job.childOrderId, lat: pos.lat, lng: pos.lng, at: at.toISOString(), simulated: true, remainingMinutes: eta?.minutes ?? null });
    return true;
  }

  function stop(jobId: string) {
    const r = running.get(jobId);
    if (r) clearInterval(r.timer);
    running.delete(jobId);
    return r?.inFlight;
  }

  return {
    start(job) {
      const id = job._id.toString();
      void stop(id);
      let i = 0;
      const entry = { timer: undefined as unknown as NodeJS.Timeout, inFlight: Promise.resolve() };
      entry.timer = setInterval(() => {
        entry.inFlight = entry.inFlight.then(async () => {
          if (running.get(id) !== entry) return;
          i += 1;
          try {
            const ok = await step(job, i);
            if (!ok || i >= SIMULATION_STEPS) stop(id);
          } catch (err) {
            ctx.logger.warn({ err, jobId: id }, 'simulator step failed');
            stop(id);
          }
        });
      }, ctx.config.SIMULATOR_STEP_MS);
      entry.timer.unref?.();
      running.set(id, entry);
      return { steps: SIMULATION_STEPS, stepMs: ctx.config.SIMULATOR_STEP_MS };
    },
    isRunning: (jobId) => running.has(jobId),
    async stopAll() {
      const pending = [...running.keys()].map((id) => stop(id));
      await Promise.allSettled(pending);
    },
  };
}
