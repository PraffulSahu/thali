/**
 * Live location (context §5 "location tracking", LLD 11). Pings are ephemeral: they update the
 * partner + the partner's active jobs, store a TTL'd `location_pings` row and publish
 * `delivery.location {childOrderId, lat, lng, at, simulated}` to `user:<customerUserId>` — never a
 * stream event. A partner can only move jobs assigned to them.
 */
import { DomainError } from '@thali/contracts';
import { publishRealtime, realtimeChannel } from '@thali/service-kit';
import type { DeliveryContext } from '../context.js';
import { ACTIVE_JOB_STATUSES, type JobLean } from '../models/delivery-job.js';
import type { PartnerLean } from '../models/partner.js';
import { toLatLng, toPoint, type LatLng } from './geo.js';
import { requirePartner } from './onboarding.js';

export interface PingInput extends LatLng {
  accuracyM?: number;
}

/**
 * Apply a real device ping. `onlyJobId` restricts job updates to one job (job-scoped route; 404 if
 * that job is not this partner's active job).
 */
export async function recordPing(ctx: DeliveryContext, userId: string, input: PingInput, onlyJobId?: string): Promise<{ at: string; jobsUpdated: number }> {
  const partner = await requirePartner(ctx, userId);
  const filter: Record<string, unknown> = { partnerId: partner._id, partnerUserId: userId, status: { $in: ACTIVE_JOB_STATUSES } };
  if (onlyJobId) {
    filter._id = onlyJobId;
    if (!(await ctx.models.Job.exists(filter))) throw new DomainError('NOT_FOUND', 'Delivery not found');
  }
  const at = ctx.now();
  const point = toPoint(input);

  await ctx.models.Partner.updateOne({ _id: partner._id }, { $set: { lastLocation: point, lastLocationAt: at } });
  const jobs = await ctx.models.Job.find(filter, { _id: 1, childOrderId: 1, customerUserId: 1 }).lean<Pick<JobLean, '_id' | 'childOrderId' | 'customerUserId'>[]>();
  if (jobs.length) {
    await ctx.models.Job.updateMany(
      { _id: { $in: jobs.map((j) => j._id) }, partnerId: partner._id, status: { $in: ACTIVE_JOB_STATUSES } },
      { $set: { lastLocation: point, lastLocationAt: at, locationSimulated: false } },
    );
  }
  const rows = jobs.length
    ? jobs.map((j) => ({ partnerId: partner._id, jobId: j._id, location: point, accuracyM: input.accuracyM ?? null, simulated: false, at }))
    : [{ partnerId: partner._id, jobId: null, location: point, accuracyM: input.accuracyM ?? null, simulated: false, at }];
  await ctx.models.LocationPing.insertMany(rows);

  for (const j of jobs) {
    await publishLocation(ctx, j.customerUserId, { childOrderId: j.childOrderId, lat: input.lat, lng: input.lng, at: at.toISOString(), simulated: false });
  }
  return { at: at.toISOString(), jobsUpdated: jobs.length };
}

export async function publishLocation(ctx: DeliveryContext, customerUserId: string, data: { childOrderId: string; lat: number; lng: number; at: string; simulated: boolean }) {
  await publishRealtime(ctx.redis, realtimeChannel.user(customerUserId), 'delivery.location', data).catch((err) =>
    ctx.logger.warn({ err, childOrderId: data.childOrderId }, 'delivery.location publish failed'),
  );
}

export interface TrackingView {
  childOrderId: string;
  status: string;
  partner: { firstName: string; vehicleType: string } | null;
  location: LatLng | null;
  lastLocationAt: string | null;
  stale: boolean;
  simulated: boolean;
  estimatedMinutes: number;
  estimateSource: string;
}

/** GET /deliveries/tracking/:childOrderId — order owner only (404 for everyone else). */
export async function trackingFor(ctx: DeliveryContext, userId: string, childOrderId: string): Promise<TrackingView> {
  const job = await ctx.models.Job.findOne({ childOrderId, customerUserId: userId }).lean<JobLean>();
  if (!job) throw new DomainError('NOT_FOUND', 'Delivery not found');
  const live = (ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status);
  let partner: TrackingView['partner'] = null;
  if (job.partnerId) {
    const p = await ctx.models.Partner.findById(job.partnerId, { name: 1, vehicle: 1 }).lean<PartnerLean>();
    if (p) partner = { firstName: p.name.trim().split(/\s+/)[0] ?? p.name, vehicleType: p.vehicle?.type ?? 'BIKE' };
  }
  // location only while a partner is actively carrying the order (privacy)
  const hasLocation = live && !!job.partnerId && !!job.lastLocation && !!job.lastLocationAt;
  const lastAt = hasLocation ? new Date(job.lastLocationAt!) : null;
  return {
    childOrderId: job.childOrderId,
    status: job.status,
    partner,
    location: hasLocation ? toLatLng(job.lastLocation!) : null,
    lastLocationAt: lastAt ? lastAt.toISOString() : null,
    stale: lastAt ? ctx.now().getTime() - lastAt.getTime() > ctx.config.LOCATION_STALE_SEC * 1000 : false,
    simulated: hasLocation ? !!job.locationSimulated : false,
    estimatedMinutes: job.estimatedMinutes,
    estimateSource: job.estimateSource,
  };
}
