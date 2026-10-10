/** OpenAPI registry for every delivery route (served at /openapi.json, /docs when DOCS_ENABLED). */
import { z } from 'zod';
import { ErrorEnvelopeSchema } from '@thali/contracts';
import { createOpenApi, registerOpsRoutes } from '@thali/service-kit';
import {
  AcceptResponse,
  AdminJobView,
  AssignBody,
  AttachDocumentBody,
  ChildOrderParams,
  CodeBody,
  CreateProfileBody,
  DocParams,
  DocumentUrlResponse,
  FailBody,
  HistoryQuery,
  IdParams,
  ItemsOf,
  JobIdParams,
  JobsQuery,
  OfferIdParams,
  OfferView,
  OnlineBody,
  OptionalReasonBody,
  OverviewResponse,
  PartnerJobView,
  PartnerView,
  PartnersQuery,
  PingBody,
  PingResponse,
  PresignResponse,
  ReasonBody,
  SimulateResponse,
  TrackingResponse,
  UpdateProfileBody,
  page,
  presignBody,
} from './schemas.js';

export const openapi = createOpenApi('delivery', { description: 'Delivery partners, dispatch & batching, assignment, handover codes, live tracking, admin TMS.' });
registerOpsRoutes(openapi);

const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
const ok = (description: string, schema: z.ZodType) => ({ 200: { description, content: json(schema) } });
const API = '/api/v1';
const incomplete = { 422: { description: 'PARTNER_PROFILE_INCOMPLETE (details.missing lists fields/documents)', content: json(ErrorEnvelopeSchema) } };

// ---------------------------------------------------------------- partner
openapi.route({
  method: 'post', path: `${API}/partner/profile`, tags: ['partner'], security: 'bearer',
  summary: 'Create my partner profile (DRAFT, idempotent) and get the DELIVERY_PARTNER role',
  request: { body: { content: json(CreateProfileBody) } },
  responses: { 201: { description: 'Created', content: json(PartnerView) }, 200: { description: 'Already existed', content: json(PartnerView) } },
  errors: ['UPSTREAM_ERROR', 'UPSTREAM_UNAVAILABLE'],
});
openapi.route({ method: 'get', path: `${API}/partner/profile`, tags: ['partner'], security: 'bearer', summary: 'My partner profile', responses: ok('Profile', PartnerView), errors: ['NOT_FOUND'] });
openapi.route({
  method: 'patch', path: `${API}/partner/profile`, tags: ['partner'], security: 'bearer', summary: 'Edit name / vehicle (before approval)',
  request: { body: { content: json(UpdateProfileBody) } }, responses: ok('Profile', PartnerView), errors: ['NOT_FOUND', 'CONFLICT'],
});
openapi.route({
  method: 'post', path: `${API}/partner/uploads`, tags: ['partner'], security: 'bearer',
  summary: 'Presign a KYC document upload (private bucket; declared size signed as Content-Length)',
  request: { body: { content: json(presignBody(5 * 1024 * 1024)) } }, responses: ok('Upload ticket', PresignResponse), errors: ['NOT_FOUND', 'CONFLICT', 'FILE_INVALID'],
});
openapi.route({
  method: 'post', path: `${API}/partner/documents`, tags: ['partner'], security: 'bearer',
  summary: 'Attach an uploaded document (verified by size + magic bytes; demo mode labels it demoVerified, never approves)',
  request: { body: { content: json(AttachDocumentBody) } }, responses: ok('Profile', PartnerView), errors: ['NOT_FOUND', 'CONFLICT', 'FILE_INVALID'],
});
openapi.route({
  method: 'post', path: `${API}/partner/submit`, tags: ['partner'], security: 'bearer', summary: 'Submit for admin approval (DRAFT/REJECTED → APPROVAL_PENDING)',
  responses: { ...ok('Profile', PartnerView), ...incomplete }, errors: ['NOT_FOUND', 'PARTNER_INVALID_TRANSITION'],
});
openapi.route({
  method: 'post', path: `${API}/partner/online`, tags: ['partner'], security: 'bearer', summary: 'Go online (APPROVED only) at the given location',
  request: { body: { content: json(OnlineBody) } }, responses: ok('Profile', PartnerView), errors: ['NOT_FOUND', 'PARTNER_NOT_APPROVED'],
});
openapi.route({ method: 'post', path: `${API}/partner/offline`, tags: ['partner'], security: 'bearer', summary: 'Go offline', responses: ok('Profile', PartnerView), errors: ['NOT_FOUND'] });
openapi.route({
  method: 'post', path: `${API}/partner/location`, tags: ['partner'], security: 'bearer', rateLimited: true,
  summary: 'Location ping (1 per 3 s): updates my active jobs and the customers\' live tracking',
  request: { body: { content: json(PingBody) } }, responses: ok('Applied', PingResponse), errors: ['NOT_FOUND'],
});
openapi.route({ method: 'get', path: `${API}/partner/offers`, tags: ['partner'], security: 'bearer', summary: 'My live offers with explainable batching reasons', responses: ok('Offers', ItemsOf(OfferView, 'OfferList')), errors: ['NOT_FOUND'] });

// ---------------------------------------------------------------- deliveries
openapi.route({
  method: 'post', path: `${API}/deliveries/offers/:offerId/accept`, tags: ['deliveries'], security: 'bearer',
  summary: 'Accept an offer (atomic: exactly one partner wins)', request: { params: OfferIdParams },
  responses: ok('Assigned', AcceptResponse), errors: ['NOT_FOUND', 'OFFER_EXPIRED', 'ASSIGNMENT_TAKEN', 'CAPACITY_EXCEEDED'],
});
openapi.route({
  method: 'post', path: `${API}/deliveries/offers/:offerId/reject`, tags: ['deliveries'], security: 'bearer', summary: 'Reject an offer',
  request: { params: OfferIdParams }, responses: ok('Rejected', OfferView), errors: ['NOT_FOUND', 'OFFER_EXPIRED'],
});
openapi.route({ method: 'get', path: `${API}/deliveries/active`, tags: ['deliveries'], security: 'bearer', summary: 'My active deliveries', responses: ok('Active', ItemsOf(PartnerJobView, 'ActiveDeliveries')), errors: ['NOT_FOUND'] });
openapi.route({
  method: 'get', path: `${API}/deliveries/history`, tags: ['deliveries'], security: 'bearer', summary: 'My finished deliveries',
  request: { query: HistoryQuery }, responses: ok('History', page(PartnerJobView, 'DeliveryHistoryPage')), errors: ['NOT_FOUND'],
});
const step = (path: string, summary: string, body?: z.ZodType, errors: Parameters<typeof openapi.route>[0]['errors'] = []) =>
  openapi.route({
    method: 'post', path: `${API}/deliveries/:jobId/${path}`, tags: ['deliveries'], security: 'bearer', summary,
    request: body ? { params: JobIdParams, body: { content: json(body) } } : { params: JobIdParams },
    responses: ok('Delivery', PartnerJobView), errors: ['NOT_FOUND', 'DELIVERY_INVALID_TRANSITION', ...(errors ?? [])],
  });
step('arrived', 'Arrived at the restaurant (ASSIGNED → AT_PICKUP)');
step('pickup', 'Confirm pickup with the restaurant code (AT_PICKUP → PICKED_UP); 5 wrong codes lock the job', CodeBody, ['DELIVERY_CODE_INVALID', 'DELIVERY_CODE_LOCKED']);
step('start', 'Start the drop leg (PICKED_UP → OUT_FOR_DELIVERY)');
step('deliver', 'Confirm delivery with the customer code (OUT_FOR_DELIVERY → DELIVERED)', CodeBody, ['DELIVERY_CODE_INVALID', 'DELIVERY_CODE_LOCKED']);
step('fail', 'Mark failed with a reason (after pickup)', FailBody);
openapi.route({
  method: 'post', path: `${API}/deliveries/:jobId/location`, tags: ['deliveries'], security: 'bearer', rateLimited: true,
  summary: 'Location ping scoped to one of my active jobs', request: { params: JobIdParams, body: { content: json(PingBody) } },
  responses: ok('Applied', PingResponse), errors: ['NOT_FOUND'],
});
openapi.route({
  method: 'get', path: `${API}/deliveries/tracking/:childOrderId`, tags: ['tracking'], security: 'bearer',
  summary: 'Live tracking for my order (owner only): partner first name, vehicle, last location, stale + simulated flags',
  request: { params: ChildOrderParams }, responses: ok('Tracking', TrackingResponse), errors: ['NOT_FOUND'],
});

// ---------------------------------------------------------------- admin
openapi.route({
  method: 'get', path: `${API}/admin/delivery/partners`, tags: ['admin-delivery'], security: 'bearer', summary: 'List partners (ADMIN+MFA)',
  request: { query: PartnersQuery }, responses: ok('Partners', page(PartnerView, 'PartnerPage')), errors: ['MFA_REQUIRED'],
});
for (const [action, reason] of [['approve', false], ['reject', true], ['suspend', true], ['reinstate', false]] as const) {
  openapi.route({
    method: 'post', path: `${API}/admin/delivery/partners/:id/${action}`, tags: ['admin-delivery'], security: 'bearer',
    summary: `${action[0]!.toUpperCase()}${action.slice(1)} a partner (ADMIN+MFA, OPS; audited)${action === 'suspend' ? ' — forces offline and returns unpicked jobs to dispatch' : ''}`,
    request: reason ? { params: IdParams, body: { content: json(ReasonBody) } } : { params: IdParams },
    responses: ok('Partner', PartnerView), errors: ['NOT_FOUND', 'PARTNER_INVALID_TRANSITION', 'MFA_REQUIRED'],
  });
}
openapi.route({
  method: 'get', path: `${API}/admin/delivery/partners/:id/documents/:docId/url`, tags: ['admin-delivery'], security: 'bearer',
  summary: 'Short-lived (5 min) KYC document URL (audited)', request: { params: DocParams }, responses: ok('URL', DocumentUrlResponse), errors: ['NOT_FOUND', 'MFA_REQUIRED'],
});
openapi.route({
  method: 'get', path: `${API}/admin/delivery/jobs`, tags: ['admin-delivery'], security: 'bearer', summary: 'List delivery jobs (filter status / exception)',
  request: { query: JobsQuery }, responses: ok('Jobs', page(AdminJobView, 'AdminDeliveryJobPage')), errors: ['MFA_REQUIRED'],
});
openapi.route({
  method: 'post', path: `${API}/admin/delivery/jobs/:id/assign`, tags: ['admin-delivery'], security: 'bearer',
  summary: 'Manual assign / reassign to an approved online partner (previous partner unassigned, capacity released)',
  request: { params: IdParams, body: { content: json(AssignBody) } }, responses: ok('Job', AdminJobView),
  errors: ['NOT_FOUND', 'PARTNER_NOT_APPROVED', 'CONFLICT', 'CAPACITY_EXCEEDED', 'DELIVERY_INVALID_TRANSITION', 'MFA_REQUIRED'],
});
openapi.route({
  method: 'post', path: `${API}/admin/delivery/jobs/:id/unassign`, tags: ['admin-delivery'], security: 'bearer', summary: 'Unassign (back to dispatch)',
  request: { params: IdParams, body: { content: json(OptionalReasonBody) } }, responses: ok('Job', AdminJobView), errors: ['NOT_FOUND', 'DELIVERY_INVALID_TRANSITION', 'MFA_REQUIRED'],
});
openapi.route({
  method: 'post', path: `${API}/admin/delivery/jobs/:id/fail`, tags: ['admin-delivery'], security: 'bearer', summary: 'Mark a picked-up delivery failed',
  request: { params: IdParams, body: { content: json(ReasonBody) } }, responses: ok('Job', AdminJobView), errors: ['NOT_FOUND', 'DELIVERY_INVALID_TRANSITION', 'MFA_REQUIRED'],
});
openapi.route({ method: 'get', path: `${API}/admin/delivery/overview`, tags: ['admin-delivery'], security: 'bearer', summary: 'TMS overview counters', responses: ok('Overview', OverviewResponse), errors: ['MFA_REQUIRED'] });
openapi.route({
  method: 'post', path: `${API}/admin/delivery/demo/simulate/:jobId`, tags: ['admin-delivery', 'demo'], security: 'bearer',
  summary: 'DEMO ONLY: simulate 10 location pings pickup → drop (flagged simulated; never changes job state). 404 outside demo.',
  request: { params: JobIdParams }, responses: { 202: { description: 'Simulation started', content: json(SimulateResponse) } }, errors: ['NOT_FOUND', 'CONFLICT', 'MFA_REQUIRED'],
});
