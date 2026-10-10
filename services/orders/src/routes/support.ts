/**
 * Customer support routes (LLD §10 orders 👤): create / list / read my tickets, add a message.
 * Tickets are scoped to `req.auth.userId`; an order reference must be the caller's own (else 404).
 */
import express from 'express';
import { requireAuth, validate, type OpenApi } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import { createTicket, customerReply, getTicket, listTickets } from '../domain/tickets.js';
import { CreateTicketBody, TicketIdParams, TicketMessageBody, TicketPage, TicketsQuery, TicketView, json } from '../order-schemas.js';
import type { RouteModule } from './types.js';

const BASE = '/api/v1/support/tickets';

function register(app: express.Express, ctx: OrdersContext): void {
  const r = express.Router();

  const vCreate = validate({ body: CreateTicketBody });
  r.post('/', requireAuth(), vCreate, async (req, res) => {
    res.status(201).json(await createTicket(ctx, req.auth!.userId, vCreate.get(req).body));
  });

  const vList = validate({ query: TicketsQuery });
  r.get('/', requireAuth(), vList, async (req, res) => {
    const { limit, cursor, status } = vList.get(req).query;
    res.json(await listTickets(ctx, { userId: req.auth!.userId, ...(status ? { status } : {}) }, { limit, cursor }));
  });

  const vGet = validate({ params: TicketIdParams });
  r.get('/:id', requireAuth(), vGet, async (req, res) => {
    res.json(await getTicket(ctx, vGet.get(req).params.id, req.auth!.userId));
  });

  const vMsg = validate({ params: TicketIdParams, body: TicketMessageBody });
  r.post('/:id/messages', requireAuth(), vMsg, async (req, res) => {
    const { params, body } = vMsg.get(req);
    res.json(await customerReply(ctx, req.auth!.userId, params.id, body.body));
  });

  app.use(BASE, r);
}

function openapi(o: OpenApi): void {
  const tags = ['support'];
  o.route({
    method: 'post',
    path: BASE,
    tags,
    summary: 'Open a support ticket (optionally about one of my orders)',
    security: 'bearer',
    request: { body: { content: json(CreateTicketBody) } },
    responses: { 201: { description: 'Ticket', content: json(TicketView) } },
    errors: ['NOT_FOUND'],
  });
  o.route({
    method: 'get',
    path: BASE,
    tags,
    summary: 'My tickets (newest first)',
    security: 'bearer',
    request: { query: TicketsQuery },
    responses: { 200: { description: 'Page of tickets', content: json(TicketPage) } },
  });
  o.route({
    method: 'get',
    path: `${BASE}/:id`,
    tags,
    summary: 'One of my tickets with its messages',
    security: 'bearer',
    request: { params: TicketIdParams },
    responses: { 200: { description: 'Ticket', content: json(TicketView) } },
    errors: ['NOT_FOUND'],
  });
  o.route({
    method: 'post',
    path: `${BASE}/:id/messages`,
    tags,
    summary: 'Reply on my ticket (reopens a RESOLVED ticket; CLOSED → 409)',
    security: 'bearer',
    request: { params: TicketIdParams, body: { content: json(TicketMessageBody) } },
    responses: { 200: { description: 'Ticket', content: json(TicketView) } },
    errors: ['NOT_FOUND', 'CONFLICT'],
  });
}

export const supportModule: RouteModule = { name: 'support', register, openapi };
