/**
 * DLV-3 live remaining ETA from the rider's last position (tracking "On the way — about 9 min").
 *
 *  - PICKED_UP / OUT_FOR_DELIVERY: eta(rider → drop)
 *  - ASSIGNED / AT_PICKUP:         eta(rider → pickup) + max(0, readyEta − now) (0 once ready) + eta(pickup → drop)
 *  - anything else, or no rider position yet: null (clients fall back to the static estimate)
 *
 * Cached per job in Redis `trk:eta:<jobId>` for 30 s (pings every ~5 s must not multiply Google calls).
 * The cached value records the job status and partner it was computed for and its `computedAt` (service
 * clock), so a status change, a reassignment or an expired entry recomputes. Never throws: Redis or geo failures degrade to a fresh
 * computation / null.
 */
import { redisKey } from '@thali/service-kit';
import type { EstimateSource } from '@thali/contracts';
import type { DeliveryContext } from '../context.js';
import type { JobLean } from '../models/delivery-job.js';
import type { PartnerLean } from '../models/partner.js';
import { toLatLng, type LatLng } from './geo.js';

export const ETA_CACHE_TTL_SEC = 30;

export interface RemainingEta {
  minutes: number;
  distanceKm: number;
  source: EstimateSource;
  computedAt: string;
}

const PRE_PICKUP = new Set(['ASSIGNED', 'AT_PICKUP']);
const POST_PICKUP = new Set(['PICKED_UP', 'OUT_FOR_DELIVERY']);
/** Weakest source wins (a fallback leg makes the whole figure a fallback). */
const SOURCE_RANK: Record<EstimateSource, number> = { GOOGLE: 0, DEMO_HAVERSINE: 1, HAVERSINE_FALLBACK: 2 };

const cacheKey = (ctx: DeliveryContext, jobId: string) => redisKey(ctx.redis, `trk:eta:${jobId}`);

type EtaJob = Pick<JobLean, '_id' | 'status' | 'partnerId' | 'pickup' | 'drop' | 'readyEta' | 'readyAt' | 'lastLocation'>;

async function riderLocation(ctx: DeliveryContext, job: EtaJob, override?: LatLng): Promise<LatLng | null> {
  if (override) return override;
  if (job.lastLocation?.coordinates?.length === 2) return toLatLng(job.lastLocation);
  if (!job.partnerId) return null;
  const p = await ctx.models.Partner.findById(job.partnerId, { lastLocation: 1 }).lean<PartnerLean>();
  return p?.lastLocation?.coordinates?.length === 2 ? toLatLng(p.lastLocation) : null;
}

async function compute(ctx: DeliveryContext, job: EtaJob, from: LatLng): Promise<RemainingEta> {
  const pickup = toLatLng(job.pickup.location);
  const drop = toLatLng(job.drop.location);
  const now = ctx.now();
  const legs = POST_PICKUP.has(job.status)
    ? [await ctx.geo.distanceAndEta(from, drop)]
    : [await ctx.geo.distanceAndEta(from, pickup), await ctx.geo.distanceAndEta(pickup, drop)];
  const waitMin = PRE_PICKUP.has(job.status) && !job.readyAt && job.readyEta ? Math.max(0, (new Date(job.readyEta).getTime() - now.getTime()) / 60_000) : 0;
  const source = legs.reduce<EstimateSource>((acc, l) => (SOURCE_RANK[l.source] > SOURCE_RANK[acc] ? l.source : acc), 'GOOGLE');
  return {
    minutes: Math.max(1, Math.ceil(legs.reduce((s, l) => s + l.etaMinutes, 0) + waitMin)),
    distanceKm: Math.round(legs.reduce((s, l) => s + l.distanceKm, 0) * 10) / 10,
    source,
    computedAt: now.toISOString(),
  };
}

/** Remaining ETA for an active, assigned job (cached 30 s); null when it cannot be estimated. */
export async function remainingEta(ctx: DeliveryContext, job: EtaJob, opts: { location?: LatLng } = {}): Promise<RemainingEta | null> {
  if (!job.partnerId || !(PRE_PICKUP.has(job.status) || POST_PICKUP.has(job.status))) return null;
  const id = job._id.toString();
  const key = cacheKey(ctx, id);
  const nowMs = ctx.now().getTime();
  try {
    const raw = await ctx.redis.get(key);
    if (raw) {
      const cached = JSON.parse(raw) as RemainingEta & { status: string; partnerId: string };
      if (cached.status === job.status && cached.partnerId === String(job.partnerId) && nowMs - Date.parse(cached.computedAt) < ETA_CACHE_TTL_SEC * 1000) {
        const { status: _s, partnerId: _p, ...rest } = cached;
        return rest;
      }
    }
  } catch (err) {
    ctx.logger.debug({ err, jobId: id }, 'eta cache read failed');
  }
  try {
    const from = await riderLocation(ctx, job, opts.location);
    if (!from) return null;
    const eta = await compute(ctx, job, from);
    await ctx.redis.set(key, JSON.stringify({ ...eta, status: job.status, partnerId: String(job.partnerId) }), 'EX', ETA_CACHE_TTL_SEC).catch((err) => ctx.logger.debug({ err, jobId: id }, 'eta cache write failed'));
    return eta;
  } catch (err) {
    ctx.logger.warn({ err, jobId: id }, 'remaining eta failed');
    return null;
  }
}
