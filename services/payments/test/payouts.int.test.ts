import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxModel, withTransaction } from '@thali/service-kit';
import { accountSummary, postEntry } from '../src/domain/ledger.js';
import { adminToken, oid, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('payouts');
});
afterAll(async () => {
  await h.cleanup();
});

const key = () => `idem-${randomBytes(8).toString('hex')}`;

async function seedEarning(accountType: 'RESTAURANT' | 'PARTNER', accountId: string, amountPaise: number) {
  await withTransaction(h.ctx.conn, (s) =>
    postEntry(h.ctx, s, {
      accountType,
      accountId,
      entryType: accountType === 'RESTAURANT' ? 'ORDER_EARNING' : 'DELIVERY_EARNING',
      amountPaise,
      dedupeKey: `seed:${randomBytes(8).toString('hex')}`,
      memo: 'seed',
      createdBy: 'test',
    }),
  );
}

function requestPayout(token: string, body: Record<string, unknown>, idem = key()) {
  return request(h.app).post('/api/v1/admin/finance/payouts').set('authorization', `Bearer ${token}`).set('idempotency-key', idem).send(body);
}

const auditCount = (targetId: string, action: string) =>
  outboxModel(h.ctx.conn).countDocuments({
    'envelope.type': 'audit.recorded',
    'envelope.payload.targetId': targetId,
    'envelope.payload.action': action,
  });

describe('recorded payouts (ADR-010)', () => {
  it('payout greater than available → 422', async () => {
    const rid = oid();
    await seedEarning('RESTAURANT', rid, 10_000);
    const token = await adminToken(h.keys);
    const res = await requestPayout(token, { accountType: 'RESTAURANT', accountId: rid, amountPaise: 10_001 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYOUT_EXCEEDS_AVAILABLE');
  });

  it('REQUESTED payout reduces available; confirm without UTR → 400; with UTR → PAID + PAYOUT ledger entry; audited', async () => {
    const rid = oid();
    await seedEarning('RESTAURANT', rid, 10_000);
    const token = await adminToken(h.keys);
    const created = await requestPayout(token, { accountType: 'RESTAURANT', accountId: rid, amountPaise: 6_000, notes: 'weekly' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'REQUESTED', amountPaise: 6_000, method: 'MANUAL_BANK_TRANSFER', utr: null });
    const id = created.body.id as string;
    let s = await accountSummary(h.ctx, 'RESTAURANT', rid);
    expect(s).toMatchObject({ balancePaise: 10_000, availablePaise: 4_000, pendingPayoutPaise: 6_000, paidOutPaise: 0 });
    expect(await auditCount(id, 'payout.request')).toBe(1);

    const second = await requestPayout(token, { accountType: 'RESTAURANT', accountId: rid, amountPaise: 4_001 });
    expect(second.status).toBe(422);

    const noUtr = await request(h.app).post(`/api/v1/admin/finance/payouts/${id}/confirm`).set('authorization', `Bearer ${token}`).send({});
    expect(noUtr.status).toBe(400);
    expect((await h.ctx.models.Payout.findById(id).lean())!.status).toBe('REQUESTED');

    const ok = await request(h.app)
      .post(`/api/v1/admin/finance/payouts/${id}/confirm`)
      .set('authorization', `Bearer ${token}`)
      .send({ utr: 'HDFCN52026101012345' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'PAID', utr: 'HDFCN52026101012345' });
    expect(ok.body.confirmedAt).toBeTruthy();
    const entries = await h.ctx.models.LedgerEntry.find({ payoutId: id }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entryType: 'PAYOUT', amountPaise: -6_000, accountType: 'RESTAURANT', accountId: rid, dedupeKey: `payout:${id}` });
    s = await accountSummary(h.ctx, 'RESTAURANT', rid);
    expect(s).toMatchObject({ balancePaise: 4_000, availablePaise: 4_000, pendingPayoutPaise: 0, paidOutPaise: 6_000 });
    expect(await auditCount(id, 'payout.confirm')).toBe(1);

    const again = await request(h.app)
      .post(`/api/v1/admin/finance/payouts/${id}/confirm`)
      .set('authorization', `Bearer ${token}`)
      .send({ utr: 'HDFCN52026101012345' });
    expect(again.status).toBe(409);
    expect(await h.ctx.models.LedgerEntry.countDocuments({ payoutId: id })).toBe(1);
  });

  it('a UTR cannot be recorded against two payouts', async () => {
    const pid = oid();
    await seedEarning('PARTNER', pid, 10_000);
    const token = await adminToken(h.keys);
    const a = await requestPayout(token, { accountType: 'PARTNER', accountId: pid, amountPaise: 1000 });
    const b = await requestPayout(token, { accountType: 'PARTNER', accountId: pid, amountPaise: 1000 });
    await request(h.app).post(`/api/v1/admin/finance/payouts/${a.body.id}/confirm`).set('authorization', `Bearer ${token}`).send({ utr: 'UTRSAME000001' });
    const dup = await request(h.app).post(`/api/v1/admin/finance/payouts/${b.body.id}/confirm`).set('authorization', `Bearer ${token}`).send({ utr: 'UTRSAME000001' });
    expect(dup.status).toBe(409);
    expect((await h.ctx.models.Payout.findById(b.body.id).lean())!.status).toBe('REQUESTED');
  });

  it('fail releases the pending amount; audited', async () => {
    const pid = oid();
    await seedEarning('PARTNER', pid, 5_000);
    const token = await adminToken(h.keys, { adm: ['SUPER_ADMIN'] });
    const p = await requestPayout(token, { accountType: 'PARTNER', accountId: pid, amountPaise: 5_000 });
    expect((await accountSummary(h.ctx, 'PARTNER', pid)).availablePaise).toBe(0);
    const f = await request(h.app).post(`/api/v1/admin/finance/payouts/${p.body.id}/fail`).set('authorization', `Bearer ${token}`).send({ reason: 'IFSC invalid' });
    expect(f.status).toBe(200);
    expect(f.body.status).toBe('FAILED');
    expect((await accountSummary(h.ctx, 'PARTNER', pid)).availablePaise).toBe(5_000);
    expect(await auditCount(p.body.id, 'payout.fail')).toBe(1);
    const confirmFailed = await request(h.app).post(`/api/v1/admin/finance/payouts/${p.body.id}/confirm`).set('authorization', `Bearer ${token}`).send({ utr: 'UTR00000000099' });
    expect(confirmFailed.status).toBe(409);
  });

  it('concurrent payout requests never exceed available', async () => {
    const rid = oid();
    await seedEarning('RESTAURANT', rid, 10_000);
    const token = await adminToken(h.keys);
    const results = await Promise.all([1, 2, 3].map(() => requestPayout(token, { accountType: 'RESTAURANT', accountId: rid, amountPaise: 4_000 })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 422)).toHaveLength(1);
  });

  it('requires FINANCE or SUPER_ADMIN with MFA, and an Idempotency-Key', async () => {
    const rid = oid();
    await seedEarning('RESTAURANT', rid, 10_000);
    const body = { accountType: 'RESTAURANT', accountId: rid, amountPaise: 100 };
    const ops = await adminToken(h.keys, { adm: ['OPS'] });
    expect((await requestPayout(ops, body)).status).toBe(403);
    const noMfa = await adminToken(h.keys, { mfa: false });
    const r = await requestPayout(noMfa, body);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MFA_REQUIRED');
    const consumer = await h.keys.sign({ sub: oid(), roles: ['CONSUMER'] });
    expect((await requestPayout(consumer, body)).status).toBe(403);
    const fin = await adminToken(h.keys);
    const noKey = await request(h.app).post('/api/v1/admin/finance/payouts').set('authorization', `Bearer ${fin}`).send(body);
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const platform = await requestPayout(fin, { accountType: 'PLATFORM', accountId: 'platform', amountPaise: 1 });
    expect(platform.status).toBe(400);
    const list = await request(h.app).get(`/api/v1/admin/finance/payouts?accountType=RESTAURANT&accountId=${rid}`).set('authorization', `Bearer ${fin}`);
    expect(list.status).toBe(200);
  });
});
