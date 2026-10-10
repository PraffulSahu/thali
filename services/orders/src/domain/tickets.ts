/**
 * Support tickets (LLD §3.3 `support_tickets`, §10 support routes). Customers open tickets — about
 * one of their own orders or in general — and exchange messages with support admins.
 *
 * Status rules (local table; 409 CONFLICT otherwise):
 *   OPEN → IN_PROGRESS | RESOLVED | CLOSED
 *   IN_PROGRESS → OPEN | RESOLVED | CLOSED
 *   RESOLVED → OPEN (customer replies) | IN_PROGRESS (admin replies) | CLOSED
 *   CLOSED is final (no replies).
 * Admin reply on OPEN/RESOLVED moves to IN_PROGRESS; customer reply on RESOLVED reopens (OPEN).
 * Admin mutations are audited (`audit.recorded`) in the same transaction.
 */
import { Types, type ClientSession } from 'mongoose';
import { DomainError, type TicketCategory, type TicketStatus } from '@thali/contracts';
import { auditEvent, buildPage, cursorFilter, PAGE_SORT, withTransaction } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import type { SupportTicket, SupportTicketDoc, TicketPriority } from '../models/support-ticket.js';
import { orderCode } from './codes.js';

const ALLOWED: Record<TicketStatus, TicketStatus[]> = {
  OPEN: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['OPEN', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['OPEN', 'IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const notFound = () => new DomainError('NOT_FOUND', 'Ticket not found');

export function ticketCode(): string {
  return `TK-${orderCode().slice(3)}`;
}

export function ticketView(t: SupportTicket) {
  return {
    id: String(t._id),
    code: t.code,
    userId: t.userId,
    childOrderId: t.childOrderId ? String(t.childOrderId) : null,
    checkoutGroupId: t.checkoutGroupId ? String(t.checkoutGroupId) : null,
    subject: t.subject,
    category: t.category,
    status: t.status,
    priority: t.priority,
    assigneeId: t.assigneeId ?? null,
    messages: (t.messages ?? []).map((m) => ({ authorId: m.authorId, authorRole: m.authorRole, body: m.body, at: iso(m.at) })),
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}
export type TicketView = ReturnType<typeof ticketView>;

function moveStatus(t: SupportTicketDoc, to: TicketStatus, actor: 'CUSTOMER' | 'ADMIN', actorId: string, reason: string | null): void {
  if (t.status === to) return;
  if (!ALLOWED[t.status].includes(to)) {
    throw new DomainError('CONFLICT', `Ticket cannot move from ${t.status} to ${to}`, 409, { from: t.status, to });
  }
  t.statusHistory.push({ from: t.status, to, actor, actorId, reason, at: new Date() });
  t.status = to;
}

export interface CreateTicketInput {
  subject: string;
  category: TicketCategory;
  body: string;
  childOrderId?: string;
  checkoutGroupId?: string;
}

export async function createTicket(ctx: OrdersContext, userId: string, input: CreateTicketInput): Promise<TicketView> {
  let childOrderId: Types.ObjectId | null = null;
  let checkoutGroupId: Types.ObjectId | null = null;
  if (input.childOrderId) {
    const c = Types.ObjectId.isValid(input.childOrderId) ? await ctx.models.ChildOrder.findById(input.childOrderId, { userId: 1, checkoutGroupId: 1 }).lean() : null;
    if (!c || c.userId !== userId) throw new DomainError('NOT_FOUND', 'Order not found');
    childOrderId = c._id;
    checkoutGroupId = c.checkoutGroupId;
  }
  if (input.checkoutGroupId) {
    const g = Types.ObjectId.isValid(input.checkoutGroupId) ? await ctx.models.CheckoutGroup.findById(input.checkoutGroupId, { userId: 1 }).lean() : null;
    if (!g || g.userId !== userId) throw new DomainError('NOT_FOUND', 'Order not found');
    if (checkoutGroupId && !checkoutGroupId.equals(g._id)) throw new DomainError('VALIDATION_FAILED', 'childOrderId does not belong to checkoutGroupId', 400);
    checkoutGroupId = g._id;
  }
  const now = new Date();
  const priority: TicketPriority = input.category === 'PAYMENT' ? 'HIGH' : 'NORMAL';
  for (let attempt = 0; ; attempt++) {
    try {
      const [t] = await ctx.models.SupportTicket.create([
        {
          code: ticketCode(),
          userId,
          childOrderId,
          checkoutGroupId,
          subject: input.subject,
          category: input.category,
          status: 'OPEN',
          priority,
          messages: [{ authorId: userId, authorRole: 'CUSTOMER', body: input.body, at: now }],
          statusHistory: [{ from: null, to: 'OPEN', actor: 'CUSTOMER', actorId: userId, reason: null, at: now }],
        },
      ]);
      return ticketView(t!);
    } catch (e) {
      if ((e as { code?: number }).code === 11000 && attempt < 3) continue; // code collision: retry
      throw e;
    }
  }
}

export async function listTickets(
  ctx: OrdersContext,
  filter: { userId?: string; status?: TicketStatus; category?: TicketCategory; assigneeId?: string },
  page: { limit: number; cursor?: string | undefined },
) {
  const q: Record<string, unknown> = { ...cursorFilter(page.cursor) };
  if (filter.userId) q.userId = filter.userId;
  if (filter.status) q.status = filter.status;
  if (filter.category) q.category = filter.category;
  if (filter.assigneeId) q.assigneeId = filter.assigneeId;
  const docs = await ctx.models.SupportTicket.find(q).sort(PAGE_SORT).limit(page.limit + 1).lean<SupportTicket[]>();
  return buildPage(docs, page.limit, ticketView);
}

async function loadTicket(ctx: OrdersContext, id: string, session?: ClientSession, userId?: string): Promise<SupportTicketDoc> {
  const t = Types.ObjectId.isValid(id) ? await ctx.models.SupportTicket.findById(id).session(session ?? null) : null;
  if (!t || (userId !== undefined && t.userId !== userId)) throw notFound();
  return t;
}

export async function getTicket(ctx: OrdersContext, id: string, userId?: string): Promise<TicketView> {
  return ticketView(await loadTicket(ctx, id, undefined, userId));
}

export async function customerReply(ctx: OrdersContext, userId: string, id: string, body: string): Promise<TicketView> {
  return withTransaction(ctx.conn, async (session) => {
    const t = await loadTicket(ctx, id, session, userId);
    if (t.status === 'CLOSED') throw new DomainError('CONFLICT', 'This ticket is closed; open a new one', 409);
    if (t.status === 'RESOLVED') moveStatus(t, 'OPEN', 'CUSTOMER', userId, 'customer replied');
    t.messages.push({ authorId: userId, authorRole: 'CUSTOMER', body, at: new Date() });
    await t.save({ session });
    return ticketView(t);
  });
}

export interface AdminActor {
  adminId: string;
  ip?: string | undefined;
}

export async function adminReply(ctx: OrdersContext, actor: AdminActor, id: string, body: string): Promise<TicketView> {
  return withTransaction(ctx.conn, async (session) => {
    const t = await loadTicket(ctx, id, session);
    if (t.status === 'CLOSED') throw new DomainError('CONFLICT', 'This ticket is closed', 409);
    if (t.status === 'OPEN' || t.status === 'RESOLVED') moveStatus(t, 'IN_PROGRESS', 'ADMIN', actor.adminId, 'support replied');
    t.messages.push({ authorId: actor.adminId, authorRole: 'ADMIN', body, at: new Date() });
    if (!t.assigneeId) t.assigneeId = actor.adminId;
    await t.save({ session });
    await auditEvent(ctx.conn, session, {
      service: 'orders',
      actorId: actor.adminId,
      actorRole: 'ADMIN',
      action: 'ticket.reply',
      targetType: 'support_ticket',
      targetId: String(t._id),
      summary: `Replied to ticket ${t.code}`,
      ...(actor.ip ? { ip: actor.ip } : {}),
    });
    return ticketView(t);
  });
}

export async function adminUpdate(
  ctx: OrdersContext,
  actor: AdminActor,
  id: string,
  patch: { status?: TicketStatus; priority?: TicketPriority; assigneeId?: string | null },
): Promise<TicketView> {
  return withTransaction(ctx.conn, async (session) => {
    const t = await loadTicket(ctx, id, session);
    const changes: string[] = [];
    if (patch.status && patch.status !== t.status) {
      changes.push(`status ${t.status}→${patch.status}`);
      moveStatus(t, patch.status, 'ADMIN', actor.adminId, null);
    }
    if (patch.priority && patch.priority !== t.priority) {
      if (t.status === 'CLOSED' && !patch.status) throw new DomainError('CONFLICT', 'This ticket is closed', 409);
      changes.push(`priority ${t.priority}→${patch.priority}`);
      t.priority = patch.priority;
    }
    if (patch.assigneeId !== undefined && patch.assigneeId !== (t.assigneeId ?? null)) {
      changes.push(`assignee → ${patch.assigneeId ?? 'none'}`);
      t.assigneeId = patch.assigneeId;
    }
    if (!changes.length) return ticketView(t);
    await t.save({ session });
    await auditEvent(ctx.conn, session, {
      service: 'orders',
      actorId: actor.adminId,
      actorRole: 'ADMIN',
      action: 'ticket.update',
      targetType: 'support_ticket',
      targetId: String(t._id),
      summary: `Ticket ${t.code}: ${changes.join(', ')}`,
      ...(actor.ip ? { ip: actor.ip } : {}),
    });
    return ticketView(t);
  });
}
