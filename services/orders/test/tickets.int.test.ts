import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, outboxEvents, setup, type Harness } from './helpers.js';
import { asAdmin, placedCheckout, type Agent } from './lifecycle-helpers.js';

let h: Harness;
let admin: Agent;
beforeAll(async () => {
  h = await setup('tickets');
  admin = await asAdmin(h);
}, 120_000);
afterAll(async () => {
  await h.cleanup();
});

describe('support tickets', () => {
  it('customer creates a ticket on their own order; not on someone else’s', async () => {
    const p = await placedCheckout(h);
    const r = await p.u.post('/api/v1/support/tickets', {
      subject: 'Dosa was cold',
      category: 'ORDER_ISSUE',
      body: 'The dosa arrived cold and soggy.',
      childOrderId: p.b.id,
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      subject: 'Dosa was cold',
      category: 'ORDER_ISSUE',
      status: 'OPEN',
      childOrderId: p.b.id,
      checkoutGroupId: p.checkout.id,
      userId: p.u.userId,
    });
    expect(r.body.code).toMatch(/^TK-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(r.body.messages).toEqual([expect.objectContaining({ authorId: p.u.userId, authorRole: 'CUSTOMER', body: 'The dosa arrived cold and soggy.' })]);

    const other = await asUser(h);
    const bad = await other.post('/api/v1/support/tickets', { subject: 'x', category: 'ORDER_ISSUE', body: 'y', childOrderId: p.b.id });
    expect(bad.status).toBe(404);
    const bad2 = await other.post('/api/v1/support/tickets', { subject: 'x', category: 'PAYMENT', body: 'y', checkoutGroupId: p.checkout.id });
    expect(bad2.status).toBe(404);
    expect((await other.get(`/api/v1/support/tickets/${r.body.id}`)).status).toBe(404);
    expect((await other.post(`/api/v1/support/tickets/${r.body.id}/messages`, { body: 'hi' })).status).toBe(404);
    expect((await p.u.post('/api/v1/support/tickets', { subject: 'x', category: 'NOPE', body: 'y' })).status).toBe(400);

    const general = await other.post('/api/v1/support/tickets', { subject: 'Account', category: 'ACCOUNT', body: 'Change my email' });
    expect(general.status).toBe(201);
    expect(general.body.childOrderId).toBeNull();

    const mine = await p.u.get('/api/v1/support/tickets');
    expect(mine.body.items.map((t: { id: string }) => t.id)).toEqual([r.body.id]);
  });

  it('admin lists, replies, changes status; customer replies reopen; closed is final', async () => {
    const p = await placedCheckout(h);
    const t = (await p.u.post('/api/v1/support/tickets', { subject: 'Refund?', category: 'PAYMENT', body: 'Where is my refund?', checkoutGroupId: p.checkout.id })).body;

    const list = await admin.get('/api/v1/admin/support/tickets?status=OPEN');
    expect(list.status).toBe(200);
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(t.id);

    const reply = await admin.post(`/api/v1/admin/support/tickets/${t.id}/messages`, { body: 'Your refund is being processed.' });
    expect(reply.status).toBe(200);
    expect(reply.body.status).toBe('IN_PROGRESS');
    expect(reply.body.messages.at(-1)).toMatchObject({ authorId: admin.userId, authorRole: 'ADMIN', body: 'Your refund is being processed.' });

    const resolved = await admin.patch(`/api/v1/admin/support/tickets/${t.id}`, { status: 'RESOLVED', priority: 'HIGH', assigneeId: admin.userId });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ status: 'RESOLVED', priority: 'HIGH', assigneeId: admin.userId });
    expect((await admin.get(`/api/v1/admin/support/tickets/${t.id}`)).body.status).toBe('RESOLVED');

    const reopen = await p.u.post(`/api/v1/support/tickets/${t.id}/messages`, { body: 'Still not received.' });
    expect(reopen.status).toBe(200);
    expect(reopen.body.status).toBe('OPEN');

    expect((await admin.patch(`/api/v1/admin/support/tickets/${t.id}`, { status: 'CLOSED' })).status).toBe(200);
    const late = await p.u.post(`/api/v1/support/tickets/${t.id}/messages`, { body: 'Hello?' });
    expect(late.status).toBe(409);
    expect((await admin.patch(`/api/v1/admin/support/tickets/${t.id}`, { status: 'OPEN' })).status).toBe(409);

    const audits = (await outboxEvents(h, 'audit.recorded')).filter((e) => e.payload.targetId === t.id);
    expect(audits.map((a) => a.payload.action)).toEqual(['ticket.reply', 'ticket.update', 'ticket.update']);

    expect((await p.u.get(`/api/v1/support/tickets/${t.id}`)).body.messages).toHaveLength(3);
    expect((await p.u.get('/api/v1/admin/support/tickets')).status).toBe(403);
  });
});
