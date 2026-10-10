/**
 * Partner onboarding, approval and availability (LLD 4.7, context §5).
 * DRAFT → APPROVAL_PENDING (profile + vehicle + required docs) → APPROVED | REJECTED (ADMIN);
 * REJECTED → APPROVAL_PENDING; APPROVED ↔ SUSPENDED (ADMIN). Only APPROVED partners go online.
 * Demo mode marks uploaded documents `demoVerified` but NEVER approves — approval is always an admin action.
 */
import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { DomainError, assertTransition, partnerTransitions, type Actor, type PartnerStatus, type Vehicle } from '@thali/contracts';
import { auditEvent, verifyUpload, withTransaction } from '@thali/service-kit';
import type { DeliveryContext } from '../context.js';
import { localError } from '../contracts-local.js';
import type { JobLean } from '../models/delivery-job.js';
import { PARTNER_DOC_TYPES, type PartnerDocType, type PartnerLean } from '../models/partner.js';
import { emit, historyEntry, unassignJob } from './job-state.js';
import { toPoint, type LatLng } from './geo.js';

export const DOC_CONTENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
const EDITABLE: PartnerStatus[] = ['DRAFT', 'REJECTED', 'APPROVAL_PENDING'];

export async function findPartnerByUser(ctx: DeliveryContext, userId: string): Promise<PartnerLean | null> {
  return ctx.models.Partner.findOne({ userId }).lean<PartnerLean>();
}

export async function requirePartner(ctx: DeliveryContext, userId: string): Promise<PartnerLean> {
  const p = await findPartnerByUser(ctx, userId);
  if (!p) throw new DomainError('NOT_FOUND', 'Create your delivery partner profile first');
  return p;
}

const kycPrefix = (userId: string) => `partner-kyc/${userId}/`;

/** POST /partner/profile — create DRAFT (idempotent) and grant DELIVERY_PARTNER via identity. */
export async function createProfile(
  ctx: DeliveryContext,
  userId: string,
  input: { name?: string; vehicle?: Vehicle },
): Promise<{ partner: PartnerLean; created: boolean }> {
  let partner = await findPartnerByUser(ctx, userId);
  let created = false;
  if (!partner) {
    const user = await ctx.identity.getUser(userId);
    const name = input.name?.trim() || user?.name?.trim();
    if (!name) throw new DomainError('VALIDATION_FAILED', 'Name is required', undefined, { issues: [{ path: 'body.name', code: 'required', message: 'Name is required' }] });
    try {
      const [doc] = await ctx.models.Partner.create([
        {
          userId,
          name,
          phone: user?.phone ?? null,
          vehicle: input.vehicle ?? null,
          status: 'DRAFT',
          statusHistory: [historyEntry(null, 'DRAFT', ctx.now(), 'PARTNER', userId)],
          online: false,
          activeJobIds: [],
          maxActive: ctx.config.MAX_ACTIVE_DELIVERIES,
          isDemo: ctx.config.APP_MODE === 'demo',
        },
      ]);
      partner = doc!.toObject() as unknown as PartnerLean;
      created = true;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      partner = (await findPartnerByUser(ctx, userId))!; // concurrent create
    }
  }
  // Idempotent grant on every call so a failed grant is repaired by retrying.
  await ctx.identity.grantRole(userId, 'DELIVERY_PARTNER');
  return { partner, created };
}

/** Vehicle changes alter the required documents, so they are only allowed before submission. */
const VEHICLE_EDITABLE: PartnerStatus[] = ['DRAFT', 'REJECTED'];

export async function updateProfile(ctx: DeliveryContext, userId: string, patch: { name?: string; vehicle?: Vehicle }): Promise<PartnerLean> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.vehicle !== undefined) set.vehicle = patch.vehicle;
  const allowed = patch.vehicle !== undefined ? VEHICLE_EDITABLE : EDITABLE;
  const updated = await ctx.models.Partner.findOneAndUpdate({ userId, status: { $in: allowed } }, { $set: set }, { new: true }).lean<PartnerLean>();
  if (updated) return updated;
  const partner = await requirePartner(ctx, userId);
  if (patch.vehicle !== undefined && partner.status === 'APPROVAL_PENDING') {
    throw new DomainError('CONFLICT', 'Vehicle details cannot change while your profile is under review; contact support');
  }
  throw new DomainError('CONFLICT', 'Profile details can only be changed before approval; contact support');
}

export async function presignDocument(ctx: DeliveryContext, userId: string, input: { type: PartnerDocType; contentType: string; sizeBytes: number }) {
  const partner = await requirePartner(ctx, userId);
  if (!EDITABLE.includes(partner.status as PartnerStatus)) throw new DomainError('CONFLICT', 'Documents can only be uploaded before approval');
  const key = `${kycPrefix(userId)}${input.type}/${randomUUID()}.${EXT[input.contentType]}`;
  const upload = await ctx.storage.presignPut({
    bucket: ctx.config.S3_PRIVATE_BUCKET,
    key,
    contentType: input.contentType,
    maxBytes: ctx.config.PARTNER_DOC_MAX_BYTES,
    contentLength: input.sizeBytes,
    expiresSec: 300,
  });
  return { key, upload };
}

export async function attachDocument(ctx: DeliveryContext, userId: string, input: { type: PartnerDocType; key: string }): Promise<PartnerLean> {
  const partner = await requirePartner(ctx, userId);
  if (!input.key.startsWith(kycPrefix(userId)) || input.key.includes('..')) throw new DomainError('FORBIDDEN', 'Upload key does not belong to you');
  if (!EDITABLE.includes(partner.status as PartnerStatus)) throw new DomainError('CONFLICT', 'Documents can only be uploaded before approval');
  const bucket = ctx.config.S3_PRIVATE_BUCKET;
  const v = await verifyUpload(ctx.storage, { bucket, key: input.key, maxBytes: ctx.config.PARTNER_DOC_MAX_BYTES, allowedTypes: [...DOC_CONTENT_TYPES] });
  if (!v.ok) {
    await ctx.storage.delete(bucket, input.key).catch(() => undefined);
    throw new DomainError('FILE_INVALID', v.reason);
  }
  const doc = {
    type: input.type,
    key: input.key,
    contentType: v.contentType,
    size: v.size,
    // demo mode only: labelled dummy verification; never changes partner status
    demoVerified: ctx.config.APP_MODE === 'demo',
    uploadedAt: ctx.now(),
  };
  const updated = await withTransaction(ctx.conn, async (session) => {
    const pulled = await ctx.models.Partner.updateOne({ _id: partner._id, status: { $in: EDITABLE } }, { $pull: { documents: { type: input.type } } }, { session });
    if (!pulled.matchedCount) throw new DomainError('CONFLICT', 'Documents can only be uploaded before approval');
    return ctx.models.Partner.findOneAndUpdate({ _id: partner._id }, { $push: { documents: doc } }, { session, new: true }).lean<PartnerLean>();
  });
  return updated!;
}

export function missingForSubmit(p: PartnerLean): string[] {
  const missing: string[] = [];
  if (!p.name?.trim()) missing.push('name');
  if (!p.vehicle) missing.push('vehicle');
  const required: PartnerDocType[] = p.vehicle?.type === 'BICYCLE' ? ['ID_PROOF'] : [...PARTNER_DOC_TYPES];
  const have = new Set((p.documents ?? []).map((d) => d.type));
  for (const t of required) if (!have.has(t)) missing.push(t);
  return missing;
}

async function changePartnerStatus(
  ctx: DeliveryContext,
  session: ClientSession,
  partner: PartnerLean,
  to: PartnerStatus,
  actor: Actor,
  opts: { actorId: string; reason?: string | null; set?: Record<string, unknown> },
): Promise<PartnerLean> {
  assertTransition(partnerTransitions, partner.status as PartnerStatus, to, actor);
  const updated = await ctx.models.Partner.findOneAndUpdate(
    { _id: partner._id, status: partner.status },
    {
      $set: { status: to, statusReason: opts.reason ?? null, ...opts.set },
      $push: { statusHistory: historyEntry(partner.status, to, ctx.now(), actor, opts.actorId, opts.reason) },
    },
    { session, new: true },
  ).lean<PartnerLean>();
  if (!updated) throw new DomainError('CONFLICT', 'The partner changed concurrently; refresh and retry');
  await emit(
    ctx,
    session,
    'partner.status_changed',
    { partnerId: partner._id.toString(), userId: partner.userId, from: partner.status as PartnerStatus, to, ...(opts.reason ? { reason: opts.reason } : {}) },
    partner._id.toString(),
  );
  return updated;
}

/** POST /partner/submit. */
export async function submitProfile(ctx: DeliveryContext, userId: string): Promise<PartnerLean> {
  return withTransaction(ctx.conn, async (session) => {
    const partner = await ctx.models.Partner.findOne({ userId }, null, { session }).lean<PartnerLean>();
    if (!partner) throw new DomainError('NOT_FOUND', 'Create your delivery partner profile first');
    assertTransition(partnerTransitions, partner.status as PartnerStatus, 'APPROVAL_PENDING', 'PARTNER');
    const missing = missingForSubmit(partner);
    if (missing.length) throw localError('PARTNER_PROFILE_INCOMPLETE', `Complete your profile before submitting: ${missing.join(', ')}`, { missing });
    return changePartnerStatus(ctx, session, partner, 'APPROVAL_PENDING', 'PARTNER', { actorId: userId });
  });
}

/** POST /partner/online {lat,lng}: APPROVED only. */
export async function goOnline(ctx: DeliveryContext, userId: string, at: LatLng): Promise<PartnerLean> {
  const now = ctx.now();
  const updated = await ctx.models.Partner.findOneAndUpdate(
    { userId, status: 'APPROVED' },
    { $set: { online: true, lastLocation: toPoint(at), lastLocationAt: now } },
    { new: true },
  ).lean<PartnerLean>();
  if (updated) return updated;
  await requirePartner(ctx, userId);
  throw new DomainError('PARTNER_NOT_APPROVED', 'Only approved partners can go online');
}

/**
 * POST /partner/offline. Refused (409 PARTNER_HAS_ACTIVE_JOBS) while the partner holds any active job
 * (ASSIGNED / AT_PICKUP / PICKED_UP / OUT_FOR_DELIVERY): finish them or ask ops to reassign.
 */
export async function goOffline(ctx: DeliveryContext, userId: string): Promise<PartnerLean> {
  const updated = await ctx.models.Partner.findOneAndUpdate({ userId, activeJobIds: { $size: 0 } }, { $set: { online: false } }, { new: true }).lean<PartnerLean>();
  if (updated) return updated;
  const partner = await requirePartner(ctx, userId);
  throw localError('PARTNER_HAS_ACTIVE_JOBS', 'You have active deliveries. Complete them or ask ops to reassign before going offline.', {
    activeJobIds: (partner.activeJobIds ?? []).map(String),
  });
}

export type AdminPartnerAction = 'approve' | 'reject' | 'suspend' | 'reinstate';
const ACTION_TARGET: Record<AdminPartnerAction, PartnerStatus> = {
  approve: 'APPROVED',
  reject: 'REJECTED',
  suspend: 'SUSPENDED',
  reinstate: 'APPROVED',
};

/**
 * Admin approve / reject / suspend / reinstate (audited). Suspension forces offline and returns
 * not-yet-picked-up jobs to PENDING_ASSIGNMENT (SYSTEM actor, LLD 4.7); picked-up jobs stay with the partner.
 */
export async function adminPartnerAction(
  ctx: DeliveryContext,
  partnerId: string,
  action: AdminPartnerAction,
  admin: { userId: string; ip?: string },
  reason?: string,
): Promise<PartnerLean> {
  const to = ACTION_TARGET[action];
  return withTransaction(ctx.conn, async (session) => {
    const partner = await ctx.models.Partner.findById(partnerId, null, { session }).lean<PartnerLean>();
    if (!partner) throw new DomainError('NOT_FOUND', 'Partner not found');
    if (action === 'reinstate' && partner.status !== 'SUSPENDED') {
      throw new DomainError('PARTNER_INVALID_TRANSITION', `Cannot reinstate a ${partner.status} partner`, undefined, { from: partner.status, to, actor: 'ADMIN' });
    }
    if (action === 'approve' && partner.status !== 'APPROVAL_PENDING') {
      throw new DomainError('PARTNER_INVALID_TRANSITION', `Cannot approve a ${partner.status} partner`, undefined, { from: partner.status, to, actor: 'ADMIN' });
    }
    if (action === 'approve') {
      // re-validate at approval time: profile/documents must still satisfy LLD 4.7 for the current vehicle
      const missing = missingForSubmit(partner);
      if (missing.length) throw localError('PARTNER_PROFILE_INCOMPLETE', `Cannot approve: missing ${missing.join(', ')}`, { missing });
    }
    let updated = await changePartnerStatus(ctx, session, partner, to, 'ADMIN', {
      actorId: admin.userId,
      reason: reason ?? null,
      set: action === 'suspend' ? { online: false } : undefined,
    });
    if (action === 'suspend') {
      // live offers to a suspended partner are withdrawn; jobs left without live offers re-dispatch now
      const now = ctx.now();
      const offered = await ctx.models.Offer.find({ partnerId: partner._id, status: 'OFFERED' }, { jobId: 1 }, { session }).lean();
      if (offered.length) {
        await ctx.models.Offer.updateMany({ partnerId: partner._id, status: 'OFFERED' }, { $set: { status: 'CANCELLED', respondedAt: now } }, { session });
        const jobIds = offered.map((o) => o.jobId);
        const stillLive = new Set(
          (await ctx.models.Offer.distinct('jobId', { jobId: { $in: jobIds }, status: 'OFFERED', expiresAt: { $gt: now } }).session(session)).map(String),
        );
        const idle = jobIds.filter((id) => !stillLive.has(id.toString()));
        if (idle.length) {
          await ctx.models.Job.updateMany({ _id: { $in: idle }, partnerId: null, status: { $in: ['PENDING_ASSIGNMENT', 'OFFERED'] } }, { $set: { nextDispatchAt: now } }, { session });
        }
      }
      const jobs = await ctx.models.Job.find({ partnerId: partner._id, status: { $in: ['ASSIGNED', 'AT_PICKUP'] } }, null, { session }).lean<JobLean[]>();
      for (const job of jobs) await unassignJob(ctx, session, job, 'SYSTEM', { actorId: admin.userId, reason: 'PARTNER_SUSPENDED' });
      if (jobs.length) updated = (await ctx.models.Partner.findById(partner._id, null, { session }).lean<PartnerLean>())!;
    }
    await auditEvent(ctx.conn, session, {
      service: 'delivery',
      actorId: admin.userId,
      actorRole: 'ADMIN',
      action: `partner.${action}`,
      targetType: 'partner',
      targetId: partner._id.toString(),
      summary: `${action} partner ${partner.name} (${partner.status} → ${to})${reason ? `: ${reason}` : ''}`,
      ip: admin.ip,
    });
    return updated;
  });
}

/** Admin: short-lived KYC document URL (5 min, LLD 14), audited. */
export async function adminDocumentUrl(ctx: DeliveryContext, partnerId: string, docId: string, admin: { userId: string; ip?: string }) {
  const partner = await ctx.models.Partner.findById(partnerId).lean<PartnerLean>();
  const doc = partner?.documents.find((d) => (d as { _id: { toString(): string } })._id.toString() === docId);
  if (!partner || !doc) throw new DomainError('NOT_FOUND', 'Document not found');
  const signed = await ctx.storage.presignGet({ bucket: ctx.config.S3_PRIVATE_BUCKET, key: doc.key, expiresSec: 300 });
  await withTransaction(ctx.conn, (session) =>
    auditEvent(ctx.conn, session, {
      service: 'delivery',
      actorId: admin.userId,
      actorRole: 'ADMIN',
      action: 'partner.document_view',
      targetType: 'partner',
      targetId: partnerId,
      summary: `Viewed ${doc.type} of ${partner.name}`,
      ip: admin.ip,
    }),
  );
  return { url: signed.url, expiresAt: signed.expiresAt, type: doc.type, demoVerified: doc.demoVerified };
}
