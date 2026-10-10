/**
 * Admin support routes (LLD §10 orders 🛡 — ADMIN + MFA; SUPPORT / OPS for mutations, audited):
 *   GET   /admin/support/tickets?status&category&assigneeId&cursor
 *   GET   /admin/support/tickets/:id
 *   PATCH /admin/support/tickets/:id {status?, priority?, assigneeId?}
 *   POST  /admin/support/tickets/:id/messages {body}
 */
import express from 'express';
import { requireAuth, validate, type OpenApi } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import { adminReply, adminUpdate, getTicket, listTickets } from '../domain/tickets.js';
import { AdminTicketPatch, AdminTicketsQuery, TicketIdParams, TicketMessageBody, TicketPage, TicketView, json } from '../order-schemas.js';
import type { RouteModule } from './types.js';

const BASE = '/api/v1/admin/support/tickets';
const adminRead = () => requireAuth({ roles: ['ADMIN'], mfa: true });
const adminWrite = () => requireAuth({ roles: ['ADMIN'], mfa: true, adminRoles: ['SUPPORT', 'OPS'] });

function register(app: express.Express, ctx: OrdersContext): void {
  const r = express.Router();

  const vList = validate({ query: AdminTicketsQuery });
  r.get('/', adminRead(), vList, async (req, res) => {
    const { limit, cursor, status, category, assigneeId } = vList.get(req).query;
    res.json(
      await listTickets(ctx, { ...(status ? { status } : {}), ...(category ? { category } : {}), ...(assigneeId ? { assigneeId } : {}) }, { limit, cursor }),
    );
  });

  const vGet = validate({ params: TicketIdParams });
  r.get('/:id', adminRead(), vGet, async (req, res) => {
    res.json(await getTicket(ctx, vGet.get(req).params.id));
  });

  const vPatch = validate({ params: TicketIdParams, body: AdminTicketPatch });
  r.patch('/:id', adminWrite(), vPatch, async (req, res) => {
    const { params, body } = vPatch.get(req);
    res.json(
      await adminUpdate(ctx, { adminId: req.auth!.userId, ip: req.ip }, params.id, {
        ...(body.status ? { status: body.status } : {}),
        ...(body.priority ? { priority: body.priority } : {}),
        ...(body.assigneeId !== undefined ? { assigneeId: body.assigneeId } : {}),
      }),
    );
  });

  const vMsg = validate({ params: TicketIdParams, body: TicketMessageBody });
  r.post('/:id/messages', adminWrite(), vMsg, async (req, res) => {
    const { params, body } = vMsg.get(req);
    res.json(await adminReply(ctx, { adminId: req.auth!.userId, ip: req.ip }, params.id, body.body));
  });

  app.use(BASE, r);
}

function openapi(o: OpenApi): void {
  const tags = ['admin-support'];
  o.route({
    method: 'get',
    path: BASE,
    tags,
    summary: 'Support ticket queue',
    security: 'bearer',
    request: { query: AdminTicketsQuery },
    responses: { 200: { description: 'Page of tickets', content: json(TicketPage) } },
    errors: ['MFA_REQUIRED'],
  });
  o.route({
    method: 'get',
    path: `${BASE}/:id`,
    tags,
    summary: 'Ticket with messages',
    security: 'bearer',
    request: { params: TicketIdParams },
    responses: { 200: { description: 'Ticket', content: json(TicketView) } },
    errors: ['NOT_FOUND', 'MFA_REQUIRED'],
  });
  o.route({
    method: 'patch',
    path: `${BASE}/:id`,
    tags,
    summary: 'Change status / priority / assignee (audited); CLOSED is final',
    security: 'bearer',
    request: { params: TicketIdParams, body: { content: json(AdminTicketPatch) } },
    responses: { 200: { description: 'Ticket', content: json(TicketView) } },
    errors: ['NOT_FOUND', 'CONFLICT', 'MFA_REQUIRED'],
  });
  o.route({
    method: 'post',
    path: `${BASE}/:id/messages`,
    tags,
    summary: 'Reply to the customer (moves OPEN/RESOLVED to IN_PROGRESS; audited)',
    security: 'bearer',
    request: { params: TicketIdParams, body: { content: json(TicketMessageBody) } },
    responses: { 200: { description: 'Ticket', content: json(TicketView) } },
    errors: ['NOT_FOUND', 'CONFLICT', 'MFA_REQUIRED'],
  });
}

export const adminSupportModule: RouteModule = { name: 'admin-support', register, openapi };
