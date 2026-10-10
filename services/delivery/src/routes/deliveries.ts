/** 🛵 partner delivery actions: offers accept/reject, active/history, execution steps, job-scoped location. */
import express, { type RequestHandler, type Router } from 'express';
import { rateLimit, requireAuth, validate } from '@thali/service-kit';
import type { DeliveryContext } from '../context.js';
import { acceptOffer, rejectOffer } from '../domain/accept.js';
import { activeJobs, confirmDelivery, confirmPickup, failDelivery, jobHistory, markArrived, startDelivery } from '../domain/execution.js';
import { revealContact } from '../domain/contact.js';
import { recordPing } from '../domain/tracking.js';
import { offerView, partnerJobView } from '../domain/views.js';
import { CodeBody, ContactBody, FailBody, HistoryQuery, JobIdParams, OfferIdParams, PingBody } from '../schemas.js';

export function deliveriesRouter(ctx: DeliveryContext, locationLimiter: RequestHandler): Router {
  const r = express.Router();
  const auth = requireAuth();
  const uid = (req: express.Request) => req.auth!.userId;
  const view = (j: Parameters<typeof partnerJobView>[0]) => partnerJobView(j, ctx.config.CODE_MAX_ATTEMPTS);

  const vOffer = validate({ params: OfferIdParams });
  r.post('/offers/:offerId/accept', auth, vOffer, async (req, res) => {
    const { offer, job } = await acceptOffer(ctx, uid(req), vOffer.get(req).params.offerId);
    res.json({ offerId: offer._id.toString(), status: 'ACCEPTED', job: view(job) });
  });
  r.post('/offers/:offerId/reject', auth, vOffer, async (req, res) => {
    const offer = await rejectOffer(ctx, uid(req), vOffer.get(req).params.offerId);
    res.json(offerView(offer, undefined));
  });

  r.get('/active', auth, async (req, res) => {
    res.json({ items: (await activeJobs(ctx, uid(req))).map(view) });
  });

  const vHistory = validate({ query: HistoryQuery });
  r.get('/history', auth, vHistory, async (req, res) => {
    const { limit, cursor } = vHistory.get(req).query;
    const page = await jobHistory(ctx, uid(req), limit, cursor);
    res.json({ items: page.items.map(view), nextCursor: page.nextCursor });
  });

  const vJob = validate({ params: JobIdParams });
  r.post('/:jobId/arrived', auth, vJob, async (req, res) => {
    res.json(view(await markArrived(ctx, uid(req), vJob.get(req).params.jobId)));
  });
  const vCode = validate({ params: JobIdParams, body: CodeBody });
  r.post('/:jobId/pickup', auth, vCode, async (req, res) => {
    const { params, body } = vCode.get(req);
    res.json(view(await confirmPickup(ctx, uid(req), params.jobId, body.code)));
  });
  r.post('/:jobId/start', auth, vJob, async (req, res) => {
    res.json(view(await startDelivery(ctx, uid(req), vJob.get(req).params.jobId)));
  });
  r.post('/:jobId/deliver', auth, vCode, async (req, res) => {
    const { params, body } = vCode.get(req);
    res.json(view(await confirmDelivery(ctx, uid(req), params.jobId, body.code)));
  });
  const vFail = validate({ params: JobIdParams, body: FailBody });
  r.post('/:jobId/fail', auth, vFail, async (req, res) => {
    const { params, body } = vFail.get(req);
    res.json(view(await failDelivery(ctx, uid(req), params.jobId, body.reason)));
  });
  // DLV-1: 10 contact reveals / min / partner. A privacy control, so it fails closed if Redis is down.
  const contactLimiter = rateLimit({
    redis: ctx.redis,
    name: 'partner-contact',
    keyFn: (req) => req.auth?.userId ?? null,
    points: 10,
    durationSec: 60,
    message: 'Too many call requests; try again in a minute',
  });
  const vContact = validate({ params: JobIdParams, body: ContactBody });
  r.post('/:jobId/contact', requireAuth({ roles: ['DELIVERY_PARTNER'] }), contactLimiter, vContact, async (req, res) => {
    const { params, body } = vContact.get(req);
    res.json(await revealContact(ctx, uid(req), params.jobId, body.target, req.ip));
  });

  const vPing = validate({ params: JobIdParams, body: PingBody });
  r.post('/:jobId/location', auth, locationLimiter, vPing, async (req, res) => {
    const { params, body } = vPing.get(req);
    res.json(await recordPing(ctx, uid(req), body, params.jobId));
  });

  return r;
}
