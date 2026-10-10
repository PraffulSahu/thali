/**
 * 🛵/👤 partner self-service: profile, KYC uploads, submit, availability, location, offers.
 * Ownership = the caller's own partner profile (looked up by `req.auth.userId`); the JWT role is
 * not required because DELIVERY_PARTNER is granted only after profile creation.
 */
import express, { type RequestHandler, type Router } from 'express';
import { requireAuth, validate } from '@thali/service-kit';
import type { DeliveryContext } from '../context.js';
import { attachDocument, createProfile, goOffline, goOnline, presignDocument, requirePartner, submitProfile, updateProfile } from '../domain/onboarding.js';
import { recordPing } from '../domain/tracking.js';
import { offerView, partnerView } from '../domain/views.js';
import type { JobLean } from '../models/delivery-job.js';
import type { OfferLean } from '../models/delivery-offer.js';
import { AttachDocumentBody, CreateProfileBody, OnlineBody, PingBody, UpdateProfileBody, presignBody } from '../schemas.js';

export function partnerRouter(ctx: DeliveryContext, locationLimiter: RequestHandler): Router {
  const r = express.Router();
  const auth = requireAuth();
  const uid = (req: express.Request) => req.auth!.userId;

  const vCreate = validate({ body: CreateProfileBody });
  r.post('/profile', auth, vCreate, async (req, res) => {
    const { partner, created } = await createProfile(ctx, uid(req), vCreate.get(req).body);
    res.status(created ? 201 : 200).json(partnerView(partner));
  });

  r.get('/profile', auth, async (req, res) => {
    res.json(partnerView(await requirePartner(ctx, uid(req))));
  });

  const vPatch = validate({ body: UpdateProfileBody });
  r.patch('/profile', auth, vPatch, async (req, res) => {
    res.json(partnerView(await updateProfile(ctx, uid(req), vPatch.get(req).body)));
  });

  const vPresign = validate({ body: presignBody(ctx.config.PARTNER_DOC_MAX_BYTES) });
  r.post('/uploads', auth, vPresign, async (req, res) => {
    res.json(await presignDocument(ctx, uid(req), vPresign.get(req).body));
  });

  const vAttach = validate({ body: AttachDocumentBody });
  r.post('/documents', auth, vAttach, async (req, res) => {
    res.json(partnerView(await attachDocument(ctx, uid(req), vAttach.get(req).body)));
  });

  r.post('/submit', auth, async (req, res) => {
    res.json(partnerView(await submitProfile(ctx, uid(req))));
  });

  const vOnline = validate({ body: OnlineBody });
  r.post('/online', auth, vOnline, async (req, res) => {
    res.json(partnerView(await goOnline(ctx, uid(req), vOnline.get(req).body)));
  });

  r.post('/offline', auth, async (req, res) => {
    res.json(partnerView(await goOffline(ctx, uid(req))));
  });

  const vPing = validate({ body: PingBody });
  r.post('/location', auth, locationLimiter, vPing, async (req, res) => {
    res.json(await recordPing(ctx, uid(req), vPing.get(req).body));
  });

  r.get('/offers', auth, async (req, res) => {
    const me = await requirePartner(ctx, uid(req));
    const offers = await ctx.models.Offer.find({ partnerId: me._id, status: 'OFFERED', expiresAt: { $gt: ctx.now() } })
      .sort({ expiresAt: 1 })
      .lean<OfferLean[]>();
    const jobs = await ctx.models.Job.find({ _id: { $in: offers.map((o) => o.jobId) } }).lean<JobLean[]>();
    const byId = new Map(jobs.map((j) => [j._id.toString(), j]));
    res.json({ items: offers.map((o) => offerView(o, byId.get(o.jobId.toString()))) });
  });

  return r;
}
