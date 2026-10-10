/** IDN-1: admin forgot / reset password. */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { redisKey } from '@thali/service-kit';
import { bootstrapAdmin } from '../src/domain/admin-auth.js';
import { PASSWORD_POLICY_MESSAGE } from '../src/domain/password-reset.js';
import { bearer, createHarness, isRevoked, refreshCookie, type Harness } from './helpers.js';
import { decodeJwt } from 'jose';

let h: Harness;
beforeAll(async () => {
  // per-IP limits are exercised separately (supertest always comes from the same IP)
  h = await createHarness('pwd_reset', { PUBLIC_WEB_URL: 'https://thali.example', ADMIN_LOGIN_MAX_PER_WINDOW: '1000' });
});
afterAll(async () => {
  await h?.close();
});

const creds = () => h.db.conn.collection('admin_credentials');
const users = () => h.db.conn.collection('users');
/** auditEvent goes through the outbox (`audit.recorded`). */
const findAudit = (action: string, targetId: string) =>
  h.db.conn.collection('outbox').findOne({ 'envelope.type': 'audit.recorded', 'envelope.payload.action': action, 'envelope.payload.targetId': targetId });
const totpAt = (secret: string, offsetSteps = 0) => authenticator.clone({ epoch: Date.now() + offsetSteps * 30_000 }).generate(secret);

let n = 0;
const uniqueEmail = () => `reset${++n}.${Date.now()}@thali.test`;
const login = (email: string, password: string) => request(h.app).post('/api/v1/auth/admin/login').send({ email, password });
const forgot = (email: string) => request(h.app).post('/api/v1/auth/admin/password/forgot').send({ email });
const reset = (body: Record<string, unknown>) => request(h.app).post('/api/v1/auth/admin/password/reset').send(body);

async function enrolledAdmin() {
  const email = uniqueEmail();
  const { password, userId } = await bootstrapAdmin(h.db.conn, { email, name: 'Ops', adminRoles: ['OPS'] });
  const l1 = await login(email, password);
  const setup = await request(h.app).post('/api/v1/auth/admin/mfa/setup').set(bearer(l1.body.accessToken));
  const secret = setup.body.secret as string;
  // enable with the previous step so later tests can use the current/next steps
  const en = await request(h.app).post('/api/v1/auth/admin/mfa/enable').set(bearer(l1.body.accessToken)).send({ code: totpAt(secret, -1) });
  if (en.status !== 200) throw new Error(`enable failed ${en.status} ${JSON.stringify(en.body)}`);
  return { email, password, userId, secret };
}

async function fullLogin(email: string, password: string, secret: string, offset: number) {
  const l = await login(email, password);
  return request(h.app).post('/api/v1/auth/admin/mfa').send({ mfaToken: l.body.mfaToken, code: totpAt(secret, offset) });
}

/** Request a reset and return the raw token from the (fake) email. */
async function issueToken(email: string): Promise<string> {
  const before = h.notifications.emails.length;
  const r = await forgot(email);
  expect(r.status).toBe(202);
  await h.settle();
  const mail = h.notifications.emails.slice(before).find((m) => m.to === email);
  if (!mail) throw new Error('no reset email');
  return new URL(String(mail.data.resetUrl)).searchParams.get('token')!;
}

describe('POST /api/v1/auth/admin/password/forgot', () => {
  it('eligible admin → 202, token stored only as sha256 (30 min), email via notifications send (contract 6), audited', async () => {
    const a = await enrolledAdmin();
    const before = h.notifications.emails.length;
    const r = await forgot(a.email.toUpperCase());
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ status: 'ACCEPTED' });
    await h.settle();

    const mails = h.notifications.emails.slice(before);
    expect(mails).toHaveLength(1);
    const mail = mails[0]!;
    expect(mail).toMatchObject({ channel: 'EMAIL', to: a.email, template: 'ADMIN_PASSWORD_RESET', data: { expiresMinutes: 30 } });
    expect(mail.dedupeKey).toMatch(/^admin-reset:[0-9a-f]{24}$/);
    const url = new URL(String(mail.data.resetUrl));
    expect(`${url.origin}${url.pathname}`).toBe('https://thali.example/admin/reset-password');
    const token = url.searchParams.get('token')!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);

    const cred = await creds().findOne({ userId: (await users().findOne({ email: a.email }))!._id });
    expect(cred!.resetTokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(cred)).not.toContain(token);
    const ttl = (cred!.resetExpiresAt as Date).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000);

    const audit = await findAudit('admin.password_reset_requested', a.userId);
    expect(audit).toBeTruthy();
    // unauthenticated request: anonymous actor, the admin is only the subject
    expect(audit!.envelope.payload).toMatchObject({ actorId: 'anonymous', actorRole: 'ANONYMOUS', targetType: 'user', targetId: a.userId });
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('unknown email, consumer email, admin without TOTP, blocked admin → identical 202, no email, no token', async () => {
    const noTotp = uniqueEmail();
    await bootstrapAdmin(h.db.conn, { email: noTotp, name: 'New', adminRoles: ['OPS'] });
    const blocked = await enrolledAdmin();
    await users().updateOne({ email: blocked.email }, { $set: { status: 'BLOCKED' } });
    const consumer = uniqueEmail();
    await users().insertOne({ email: consumer, roles: ['CONSUMER'], adminRoles: [], status: 'ACTIVE', addresses: [], createdAt: new Date(), updatedAt: new Date() });

    const real = await enrolledAdmin();
    const realRes = await forgot(real.email);
    await h.settle();
    const before = h.notifications.emails.length;
    for (const email of [`nobody.${Date.now()}@thali.test`, consumer, noTotp, blocked.email]) {
      const r = await forgot(email);
      expect(r.status, email).toBe(202);
      expect(r.body).toEqual(realRes.body);
      expect(Object.keys(r.headers).sort()).toEqual(Object.keys(realRes.headers).sort());
    }
    await h.settle();
    expect(h.notifications.emails.length).toBe(before);
    for (const email of [noTotp, blocked.email]) {
      const u = await users().findOne({ email });
      expect((await creds().findOne({ userId: u!._id }))!.resetTokenHash ?? null, email).toBeNull();
    }
  });

  it('locked admin → 202 but no email', async () => {
    const a = await enrolledAdmin();
    const user = await users().findOne({ email: a.email });
    await creds().updateOne({ userId: user!._id }, { $set: { lockedUntil: new Date(Date.now() + 600_000) } });
    const before = h.notifications.emails.length;
    expect((await forgot(a.email)).status).toBe(202);
    await h.settle();
    expect(h.notifications.emails.length).toBe(before);
  });

  it('notifications unreachable → still 202; provider error recorded for the health page', async () => {
    const a = await enrolledAdmin();
    h.notifications.failSend = true;
    try {
      expect((await forgot(a.email)).status).toBe(202);
      await h.settle();
    } finally {
      h.notifications.failSend = false;
    }
    const raw = await h.tr.redis.hget(redisKey(h.tr.redis, 'provider_last_error:identity'), 'notifications');
    expect(JSON.parse(raw!).message).toMatch(/ECONNREFUSED/);
  });

  it('a new request replaces the previous token', async () => {
    const a = await enrolledAdmin();
    const t1 = await issueToken(a.email);
    const t2 = await issueToken(a.email);
    expect(t1).not.toBe(t2);
    const r = await reset({ token: t1, newPassword: 'another-strong-password', totpCode: totpAt(a.secret) });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rate limited per email (3 / window) regardless of whether the account exists', async () => {
    const email = `limit.${Date.now()}@thali.test`;
    for (let i = 0; i < 3; i++) expect((await forgot(email)).status).toBe(202);
    const r = await forgot(email);
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
  });

  it('rate limited per IP like admin login (forgot and reset)', async () => {
    const app = h.appWith({ ADMIN_LOGIN_MAX_PER_WINDOW: '2' });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await request(app).post('/api/v1/auth/admin/password/forgot').send({ email: `ip${i}.${Date.now()}@thali.test` })).status);
    }
    expect(statuses[2]).toBe(429);
    const resets: number[] = [];
    for (let i = 0; i < 3; i++) {
      resets.push((await request(app).post('/api/v1/auth/admin/password/reset').send({ token: 'B'.repeat(43), newPassword: 'a-long-new-password', totpCode: '123456' })).status);
    }
    expect(resets[2]).toBe(429);
  });

  it('validates the body', async () => {
    const r = await forgot('not-an-email');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /api/v1/auth/admin/password/reset', () => {
  it('valid token + TOTP + policy password → 204; old password fails, new works; all sessions revoked; token single use; audited', async () => {
    const a = await enrolledAdmin();
    const session = await fullLogin(a.email, a.password, a.secret, 0);
    expect(session.status).toBe(200);
    const sid = String(decodeJwt(session.body.accessToken).sid);
    const cookie = refreshCookie(session)!;

    const token = await issueToken(a.email);
    const newPassword = 'correct-horse-battery-staple';
    const r = await reset({ token, newPassword, totpCode: totpAt(a.secret, 1) });
    expect(r.status).toBe(204);

    expect(await isRevoked(h, sid)).toBe(true);
    const refreshed = await request(h.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'thali-web')
      .set('Origin', 'http://localhost:5173');
    expect(refreshed.status).toBe(401);

    expect((await login(a.email, a.password)).status).toBe(401);
    const ok = await login(a.email, newPassword);
    expect(ok.status).toBe(200);
    expect(ok.body.mfaRequired).toBe(true);

    const again = await reset({ token, newPassword: 'yet-another-password-1', totpCode: totpAt(a.secret, 2) });
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('INVALID_CREDENTIALS');

    const user = await users().findOne({ email: a.email });
    const cred = await creds().findOne({ userId: user!._id });
    expect(cred!.resetTokenHash).toBeNull();
    expect(String(cred!.passwordHash).startsWith('$argon2id$')).toBe(true);
    const audit = await findAudit('admin.password_reset_completed', a.userId);
    expect(audit).toBeTruthy();
  });

  it('wrong TOTP → 401 and counts toward the lockout; locked admin cannot reset', async () => {
    const a = await enrolledAdmin();
    const token = await issueToken(a.email);
    const wrong = totpAt(a.secret) === '000000' ? '111111' : '000000';
    const r = await reset({ token, newPassword: 'a-long-new-password', totpCode: wrong });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
    const user = await users().findOne({ email: a.email });
    expect((await creds().findOne({ userId: user!._id }))!.failedAttempts).toBe(1);
    const failed = await findAudit('admin.password_reset_failed', a.userId);
    expect(failed!.envelope.payload).toMatchObject({ actorId: 'anonymous', actorRole: 'ANONYMOUS', targetId: a.userId });

    for (let i = 0; i < 3; i++) await reset({ token, newPassword: 'a-long-new-password', totpCode: wrong });
    const locked = await reset({ token, newPassword: 'a-long-new-password', totpCode: wrong });
    expect(locked.status).toBe(423);
    const stillLocked = await reset({ token, newPassword: 'a-long-new-password', totpCode: totpAt(a.secret, 1) });
    expect(stillLocked.status).toBe(423);
    expect(stillLocked.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('blocked admin cannot reset (403 ACCOUNT_BLOCKED)', async () => {
    const a = await enrolledAdmin();
    const token = await issueToken(a.email);
    await users().updateOne({ email: a.email }, { $set: { status: 'BLOCKED' } });
    const r = await reset({ token, newPassword: 'a-long-new-password', totpCode: totpAt(a.secret, 1) });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ACCOUNT_BLOCKED');
  });

  it('expired token → 401', async () => {
    const a = await enrolledAdmin();
    const token = await issueToken(a.email);
    const user = await users().findOne({ email: a.email });
    await creds().updateOne({ userId: user!._id }, { $set: { resetExpiresAt: new Date(Date.now() - 1000) } });
    const r = await reset({ token, newPassword: 'a-long-new-password', totpCode: totpAt(a.secret, 1) });
    expect(r.status).toBe(401);
  });

  it('password policy: < 12 chars → 400 (schema); same as current → generic policy 400 only after the TOTP is verified AND consumed', async () => {
    const a = await enrolledAdmin();
    const token = await issueToken(a.email);
    const short = await reset({ token, newPassword: 'short', totpCode: totpAt(a.secret, 1) });
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe('VALIDATION_FAILED');

    // wrong TOTP + current password → 401 (TOTP first: no password oracle without a valid code)
    const wrong = totpAt(a.secret) === '000000' ? '111111' : '000000';
    const noCode = await reset({ token, newPassword: a.password, totpCode: wrong });
    expect(noCode.status).toBe(401);

    const code = totpAt(a.secret, 0);
    const same = await reset({ token, newPassword: a.password, totpCode: code });
    expect(same.status).toBe(400);
    expect(same.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: PASSWORD_POLICY_MESSAGE });
    // the code was consumed by that attempt: probing again with it fails before any password check
    const probe = await reset({ token, newPassword: a.password, totpCode: code });
    expect(probe.status).toBe(401);

    const ok = await reset({ token, newPassword: 'finally-a-good-password', totpCode: totpAt(a.secret, 1) });
    expect(ok.status).toBe(204);
  });

  it('a TOTP code already used for login cannot be replayed for reset', async () => {
    const a = await enrolledAdmin();
    const code = totpAt(a.secret, 1); // one string, reused (no step-boundary flake)
    const l = await login(a.email, a.password);
    const s = await request(h.app).post('/api/v1/auth/admin/mfa').send({ mfaToken: l.body.mfaToken, code });
    expect(s.status).toBe(200);
    const token = await issueToken(a.email);
    const r = await reset({ token, newPassword: 'a-long-new-password', totpCode: code });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('an mfaToken issued before the reset (pending login with the old password) is rejected afterwards', async () => {
    const a = await enrolledAdmin();
    const pending = await login(a.email, a.password);
    expect(pending.body.mfaRequired).toBe(true);
    const token = await issueToken(a.email);
    expect((await reset({ token, newPassword: 'brand-new-password-1', totpCode: totpAt(a.secret, 0) })).status).toBe(204);

    const user = await users().findOne({ email: a.email });
    const cred = await creds().findOne({ userId: user!._id });
    expect(cred!.credentialVersion).toBe(1);
    expect(cred!.passwordChangedAt).toBeInstanceOf(Date);

    const stale = await request(h.app).post('/api/v1/auth/admin/mfa').send({ mfaToken: pending.body.mfaToken, code: totpAt(a.secret, 1) });
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('UNAUTHENTICATED');
    // a login with the new password gets a fresh token that works
    const fresh = await login(a.email, 'brand-new-password-1');
    const ok = await request(h.app).post('/api/v1/auth/admin/mfa').send({ mfaToken: fresh.body.mfaToken, code: totpAt(a.secret, 1) });
    expect(ok.status).toBe(200);
  });

  it('malformed token → 400; unknown token → 401', async () => {
    expect((await reset({ token: 'abc', newPassword: 'a-long-new-password', totpCode: '123456' })).status).toBe(400);
    const r = await reset({ token: 'A'.repeat(43), newPassword: 'a-long-new-password', totpCode: '123456' });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});
