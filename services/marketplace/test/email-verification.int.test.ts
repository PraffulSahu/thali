import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createHarness, fullProfile, settlementBody, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness('emailverify');
});
afterAll(async () => h?.close());

/** Create + complete + submit; returns id, token and the verify path (from the outbox event). */
async function submitted() {
  const token = await h.ownerToken();
  const c = await request(h.app).post('/api/v1/owner/restaurants').set(bearer(token)).send({ name: 'Verify Me' });
  const id = c.body.restaurant.id as string;
  await request(h.app).patch(`/api/v1/owner/restaurants/${id}`).set(bearer(token)).send(fullProfile()).expect(200);
  await request(h.app).put(`/api/v1/owner/restaurants/${id}/settlement`).set(bearer(token)).send(settlementBody).expect(200);
  await request(h.app).post(`/api/v1/owner/restaurants/${id}/submit`).set(bearer(token)).expect(200);
  return { id, token, path: await latestVerifyPath(id) };
}

async function latestVerifyPath(id: string) {
  const ev = (await h.events('restaurant.email_verification_requested')).filter((e) => e.aggregateId === id);
  const u = new URL(String(ev.at(-1)!.payload.verifyUrl));
  return `${u.pathname}${u.search}`;
}

const status = async (id: string) => (await h.models.Restaurant.findById(id).lean())!.status;

describe('business email verification', () => {
  it('valid token → APPROVAL_PENDING + 302 redirect to the SPA with emailVerified=1', async () => {
    const { id, path } = await submitted();
    const res = await request(h.app).get(path);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://web.test/restaurant/onboarding?emailVerified=1');
    expect(await status(id)).toBe('APPROVAL_PENDING');
    const doc = await h.models.Restaurant.findById(id).lean();
    expect(doc!.emailVerifiedAt).toBeInstanceOf(Date);
    const changed = (await h.events('restaurant.status_changed')).filter((e) => e.aggregateId === id);
    expect(changed.map((e) => [e.payload.from, e.payload.to])).toEqual([
      ['DRAFT', 'VERIFICATION_PENDING'],
      ['VERIFICATION_PENDING', 'APPROVAL_PENDING'],
    ]);
    expect(changed[1]!.payload).toMatchObject({ name: 'Spice Route' });
  });

  it('expired token → redirect with reason=expired; status unchanged', async () => {
    const { id, path } = await submitted();
    await h.models.Restaurant.updateOne({ _id: id }, { $set: { 'emailVerification.expiresAt': new Date(Date.now() - 1000) } });
    const res = await request(h.app).get(path);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://web.test/restaurant/onboarding?emailVerified=0&reason=expired');
    expect(await status(id)).toBe('VERIFICATION_PENDING');
  });

  it('reused token → no-op (no second transition or event)', async () => {
    const { id, path } = await submitted();
    await request(h.app).get(path).expect(302);
    const before = await h.models.Restaurant.findById(id).lean();
    const res = await request(h.app).get(path);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://web.test/restaurant/onboarding?emailVerified=1&reason=already_verified');
    const after = await h.models.Restaurant.findById(id).lean();
    expect(after!.status).toBe('APPROVAL_PENDING');
    expect(after!.emailVerifiedAt!.getTime()).toBe(before!.emailVerifiedAt!.getTime());
    expect((await h.events('restaurant.status_changed')).filter((e) => e.aggregateId === id)).toHaveLength(2); // submit + verify only
  });

  it('wrong or missing token → reason=invalid', async () => {
    const { id } = await submitted();
    const res = await request(h.app).get('/api/v1/restaurants/verify-email?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://web.test/restaurant/onboarding?emailVerified=0&reason=invalid');
    const missing = await request(h.app).get('/api/v1/restaurants/verify-email');
    expect(missing.headers.location).toBe('http://web.test/restaurant/onboarding?emailVerified=0&reason=invalid');
    expect(await status(id)).toBe('VERIFICATION_PENDING');
  });

  it('resend: 60 s cooldown, new token replaces the old one', async () => {
    const { id, token, path: oldPath } = await submitted();
    const tooSoon = await request(h.app).post(`/api/v1/owner/restaurants/${id}/resend-verification`).set(bearer(token));
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error.code).toBe('RATE_LIMITED');
    expect(Number(tooSoon.headers['retry-after'])).toBeGreaterThan(0);

    await h.models.Restaurant.updateOne({ _id: id }, { $set: { 'emailVerificationLog.lastSentAt': new Date(Date.now() - 61_000) } });
    const ok = await request(h.app).post(`/api/v1/owner/restaurants/${id}/resend-verification`).set(bearer(token));
    expect(ok.status).toBe(202);
    expect(new Date(ok.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    const newPath = await latestVerifyPath(id);
    expect(newPath).not.toBe(oldPath);

    expect((await request(h.app).get(oldPath)).headers.location).toContain('reason=invalid');
    expect((await request(h.app).get(newPath)).headers.location).toBe('http://web.test/restaurant/onboarding?emailVerified=1');
    expect(await status(id)).toBe('APPROVAL_PENDING');
  });

  it('businessEmail changes obey the same 60 s cooldown (no email-bombing via PATCH)', async () => {
    const { id, token } = await submitted();
    const res = await request(h.app).patch(`/api/v1/owner/restaurants/${id}`).set(bearer(token)).send({ businessEmail: 'victim@example.test' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    const doc = await h.models.Restaurant.findById(id).lean();
    expect(doc!.businessEmail).toBe('owner@spiceroute.test'); // whole PATCH rolled back
    const sent = (await h.events('restaurant.email_verification_requested')).filter((e) => e.aggregateId === id);
    expect(sent).toHaveLength(1);
  });

  it('per-restaurant cap: at most 5 verification emails per 24 h across resend and email changes', async () => {
    const { id, token } = await submitted(); // send #1
    const backdate = () => h.models.Restaurant.updateOne({ _id: id }, { $set: { 'emailVerificationLog.lastSentAt': new Date(Date.now() - 61_000) } });
    for (let i = 2; i <= 5; i++) {
      await backdate();
      const res =
        i % 2 === 0
          ? await request(h.app).post(`/api/v1/owner/restaurants/${id}/resend-verification`).set(bearer(token))
          : await request(h.app).patch(`/api/v1/owner/restaurants/${id}`).set(bearer(token)).send({ businessEmail: `owner${i}@spiceroute.test` });
      expect(res.status).toBeLessThan(300);
    }
    await backdate();
    const sixth = await request(h.app).post(`/api/v1/owner/restaurants/${id}/resend-verification`).set(bearer(token));
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.message).toContain('limit');
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(23 * 3600);
    const viaPatch = await request(h.app).patch(`/api/v1/owner/restaurants/${id}`).set(bearer(token)).send({ businessEmail: 'another@spiceroute.test' });
    expect(viaPatch.status).toBe(429);
    expect((await h.events('restaurant.email_verification_requested')).filter((e) => e.aggregateId === id)).toHaveLength(5);

    // the window rolls over after 24 h
    await h.models.Restaurant.updateOne({ _id: id }, { $set: { 'emailVerificationLog.windowStart': new Date(Date.now() - 24 * 3600_000 - 1000) } });
    expect((await request(h.app).post(`/api/v1/owner/restaurants/${id}/resend-verification`).set(bearer(token))).status).toBe(202);
  });

  it('resend is rejected when there is nothing to verify (DRAFT)', async () => {
    const token = await h.ownerToken();
    const c = await request(h.app).post('/api/v1/owner/restaurants').set(bearer(token)).send({ name: 'Draft' });
    const res = await request(h.app).post(`/api/v1/owner/restaurants/${c.body.restaurant.id}/resend-verification`).set(bearer(token));
    expect(res.status).toBe(409);
  });
});
