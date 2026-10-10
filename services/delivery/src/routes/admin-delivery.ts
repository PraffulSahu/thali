/**
 * 🛡 admin TMS (ADMIN + MFA). Reads: any admin sub-role; mutations: OPS (SUPER_ADMIN always passes).
 * Demo simulator: 404 unless APP_MODE=demo.
 */
import express, { type Router } from 'express';
import { DomainError } from '@thali/contracts';
import { requireAuth, validate } from '@thali/service-kit';
import type { DeliveryContext } from '../context.js';
import { adminDocumentUrl, adminPartnerAction, type AdminPartnerAction } from '../domain/onboarding.js';
import { adminAssign, adminFail, adminSimulate, adminUnassign, listJobs, listPartners, overview } from '../domain/tms.js';
import { adminJobView, partnerView } from '../domain/views.js';
import { AssignBody, DocParams, IdParams, JobIdParams, JobsQuery, OptionalReasonBody, PartnersQuery, ReasonBody } from '../schemas.js';

export function adminDeliveryRouter(ctx: DeliveryContext): Router {
  const r = express.Router();
  const read = requireAuth({ roles: ['ADMIN'], mfa: true });
  const write = requireAuth({ roles: ['ADMIN'], mfa: true, adminRoles: ['OPS'] });
  const actor = (req: express.Request) => ({ userId: req.auth!.userId, ip: req.ip });

  const vPartners = validate({ query: PartnersQuery });
  r.get('/partners', read, vPartners, async (req, res) => {
    const page = await listPartners(ctx, vPartners.get(req).query);
    res.json({ items: page.items.map(partnerView), nextCursor: page.nextCursor });
  });

  const vId = validate({ params: IdParams });
  const vIdReason = validate({ params: IdParams, body: ReasonBody });
  const partnerAction = (action: AdminPartnerAction, needsReason: boolean) => {
    const v = needsReason ? vIdReason : vId;
    r.post(`/partners/:id/${action}`, write, v, async (req, res) => {
      const { params, body } = v.get(req) as { params: { id: string }; body?: { reason: string } };
      res.json(partnerView(await adminPartnerAction(ctx, params.id, action, actor(req), body?.reason)));
    });
  };
  partnerAction('approve', false);
  partnerAction('reject', true);
  partnerAction('suspend', true);
  partnerAction('reinstate', false);

  const vDoc = validate({ params: DocParams });
  r.get('/partners/:id/documents/:docId/url', read, vDoc, async (req, res) => {
    const { id, docId } = vDoc.get(req).params;
    res.json(await adminDocumentUrl(ctx, id, docId, actor(req)));
  });

  const vJobs = validate({ query: JobsQuery });
  r.get('/jobs', read, vJobs, async (req, res) => {
    const page = await listJobs(ctx, vJobs.get(req).query);
    res.json({ items: page.items.map(adminJobView), nextCursor: page.nextCursor });
  });

  const vAssign = validate({ params: IdParams, body: AssignBody });
  r.post('/jobs/:id/assign', write, vAssign, async (req, res) => {
    const { params, body } = vAssign.get(req);
    res.json(adminJobView(await adminAssign(ctx, params.id, body.partnerId, actor(req))));
  });
  const vUnassign = validate({ params: IdParams, body: OptionalReasonBody });
  r.post('/jobs/:id/unassign', write, vUnassign, async (req, res) => {
    const { params, body } = vUnassign.get(req);
    res.json(adminJobView(await adminUnassign(ctx, params.id, actor(req), body.reason)));
  });
  r.post('/jobs/:id/fail', write, vIdReason, async (req, res) => {
    const { params, body } = vIdReason.get(req);
    res.json(adminJobView(await adminFail(ctx, params.id, body.reason, actor(req))));
  });

  r.get('/overview', read, async (_req, res) => {
    res.json(await overview(ctx));
  });

  // Demo only: indistinguishable from an unknown route outside demo mode.
  const demoOnly: express.RequestHandler = (_req, _res, next) => {
    if (ctx.config.APP_MODE !== 'demo') throw new DomainError('NOT_FOUND', 'Not found');
    next();
  };
  const vSim = validate({ params: JobIdParams });
  r.post('/demo/simulate/:jobId', demoOnly, write, vSim, async (req, res) => {
    res.status(202).json(await adminSimulate(ctx, vSim.get(req).params.jobId, actor(req)));
  });

  return r;
}
