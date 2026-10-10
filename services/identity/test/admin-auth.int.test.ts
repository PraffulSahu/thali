import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { decodeJwt } from 'jose';
import { authenticator } from 'otplib';
import { bootstrapAdmin } from '../src/domain/admin-auth.js';
import { runBootstrapAdmin } from '../src/cli/bootstrap-admin.js';
import { bearer, createHarness, rawSetCookie, refreshCookie, withCsrf, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness('admin_auth');
});
afterAll(async () => {
  await h?.close();
});

const creds = () => h.db.conn.collection('admin_credentials');
const totpAt = (secret: string, offsetSteps = 0) =>
  authenticator.clone({ epoch: Date.now() + offsetSteps * 30_000 }).generate(secret);

let n = 0;
const uniqueEmail = () => `admin${++n}.${Date.now()}@thali.test`;

const login = (email: string, password: string) => request(h.app).post('/api/v1/auth/admin/login').send({ email, password });

/** Full first-time flow: bootstrap → login (pwd-only) → setup → enable. Returns secret for later logins. */
async function enrolledAdmin(adminRoles: ('SUPER_ADMIN' | 'OPS' | 'FINANCE' | 'SUPPORT')[] = ['SUPER_ADMIN']) {
  const email = uniqueEmail();
  const { password, userId } = await bootstrapAdmin(h.db.conn, { email, name: 'Ops', adminRoles });
  const l1 = await login(email, password);
  const setup = await request(h.app).post('/api/v1/auth/admin/mfa/setup').set(bearer(l1.body.accessToken));
  const secret = setup.body.secret as string;
  const en = await request(h.app).post('/api/v1/auth/admin/mfa/enable').set(bearer(l1.body.accessToken)).send({ code: totpAt(secret) });
  if (en.status !== 200) throw new Error(`enable failed ${en.status} ${JSON.stringify(en.body)}`);
  return { email, password, userId, secret };
}

async function fullLogin(email: string, password: string, secret: string, offset = 1) {
  const l = await login(email, password);
  return request(h.app).post('/api/v1/auth/admin/mfa').send({ mfaToken: l.body.mfaToken, code: totpAt(secret, offset) });
}

describe('admin auth', () => {
  it('there is no public admin registration route', async () => {
    const r = await request(h.app).post('/api/v1/auth/admin/register').send({ email: 'x@y.z', password: 'p' });
    expect(r.status).toBe(404);
  });

  it('bootstrap stores an argon2id hash; login without TOTP → mfaSetupRequired + pwd-only token rejected by admin routes', async () => {
    const email = uniqueEmail();
    const { password, userId } = await bootstrapAdmin(h.db.conn, { email, name: 'Ops', adminRoles: ['SUPER_ADMIN'] });
    expect(password.length).toBeGreaterThanOrEqual(16);
    const cred = await creds().findOne({});
    expect(String(cred!.passwordHash).startsWith('$argon2id$')).toBe(true);
    const user = await h.db.conn.collection('users').findOne({ email });
    expect(user!.roles).toEqual(expect.arrayContaining(['CONSUMER', 'ADMIN']));
    expect(user!.adminRoles).toEqual(['SUPER_ADMIN']);
    expect(String(user!._id)).toBe(userId);

    const r = await login(email, password);
    expect(r.status).toBe(200);
    expect(r.body.mfaSetupRequired).toBe(true);
    expect(r.body.mfaRequired).toBeUndefined();
    expect(refreshCookie(r)).toBeNull();
    const claims = decodeJwt(r.body.accessToken);
    expect(claims.amr).toEqual(['pwd']);
    expect(claims.roles).toEqual(expect.arrayContaining(['ADMIN']));

    const denied = await request(h.app).get('/api/v1/admin/users').set(bearer(r.body.accessToken));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('MFA_REQUIRED');
  });

  it('setup → enable (valid TOTP) → login → mfaRequired → /auth/admin/mfa → amr incl mfa → /admin/users 200', async () => {
    const email = uniqueEmail();
    const { password } = await bootstrapAdmin(h.db.conn, { email, name: 'Ops', adminRoles: ['OPS'] });
    const l1 = await login(email, password);
    const setup = await request(h.app).post('/api/v1/auth/admin/mfa/setup').set(bearer(l1.body.accessToken));
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const secret = setup.body.secret as string;
    const cred = await creds().findOne({ totpEnabled: false, totpSecretEnc: { $ne: null } });
    expect(String(cred!.totpSecretEnc).startsWith('v1:')).toBe(true);
    expect(String(cred!.totpSecretEnc)).not.toContain(secret);

    const badEnable = await request(h.app).post('/api/v1/auth/admin/mfa/enable').set(bearer(l1.body.accessToken)).send({ code: '000000' });
    expect(badEnable.status).toBe(401);

    const en = await request(h.app).post('/api/v1/auth/admin/mfa/enable').set(bearer(l1.body.accessToken)).send({ code: totpAt(secret) });
    expect(en.status).toBe(200);
    expect(en.body.enabled).toBe(true);

    const l2 = await login(email, password);
    expect(l2.status).toBe(200);
    expect(l2.body.mfaRequired).toBe(true);
    expect(typeof l2.body.mfaToken).toBe('string');
    expect(l2.body.accessToken).toBeUndefined();
    // mfaToken is not an access token
    expect((await request(h.app).get('/api/v1/me').set(bearer(l2.body.mfaToken))).status).toBe(401);

    const m = await request(h.app).post('/api/v1/auth/admin/mfa').send({ mfaToken: l2.body.mfaToken, code: totpAt(secret, 1) });
    expect(m.status).toBe(200);
    const claims = decodeJwt(m.body.accessToken);
    expect(claims.amr).toEqual(['pwd', 'mfa']);
    expect(claims.adm).toEqual(['OPS']);
    expect(claims.iss).toBe('thali-identity');
    expect(claims.aud).toBe('thali');
    expect(rawSetCookie(m)).toMatch(/HttpOnly/i);

    const ok = await request(h.app).get('/api/v1/admin/users').set(bearer(m.body.accessToken));
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.items)).toBe(true);

    // admin refresh keeps amr incl. mfa
    const rf = await withCsrf(request(h.app).post('/api/v1/auth/refresh')).set('Cookie', refreshCookie(m)!);
    expect(rf.status).toBe(200);
    expect(decodeJwt(rf.body.accessToken).amr).toEqual(['pwd', 'mfa']);
  });

  it('setup is refused once TOTP is enabled', async () => {
    const a = await enrolledAdmin();
    const m = await fullLogin(a.email, a.password, a.secret);
    const r = await request(h.app).post('/api/v1/auth/admin/mfa/setup').set(bearer(m.body.accessToken));
    expect(r.status).toBe(409);
  });

  it('TOTP replay of the same code within the window is rejected', async () => {
    const a = await enrolledAdmin();
    const code = totpAt(a.secret, 1);
    const l1 = await login(a.email, a.password);
    const ok = await request(h.app).post('/api/v1/auth/admin/mfa').send({ mfaToken: l1.body.mfaToken, code });
    expect(ok.status).toBe(200);
    const l2 = await login(a.email, a.password);
    const replay = await request(h.app).post('/api/v1/auth/admin/mfa').send({ mfaToken: l2.body.mfaToken, code });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('the enable code cannot be replayed for login', async () => {
    const email = uniqueEmail();
    const { password } = await bootstrapAdmin(h.db.conn, { email, name: 'Ops', adminRoles: ['OPS'] });
    const l1 = await login(email, password);
    const secret = (await request(h.app).post('/api/v1/auth/admin/mfa/setup').set(bearer(l1.body.accessToken))).body.secret;
    const code = totpAt(secret);
    await request(h.app).post('/api/v1/auth/admin/mfa/enable').set(bearer(l1.body.accessToken)).send({ code });
    const l2 = await login(email, password);
    const r = await request(h.app).post('/api/v1/auth/admin/mfa').send({ mfaToken: l2.body.mfaToken, code });
    expect(r.status).toBe(401);
  });

  it('5 bad passwords → locked 15 min (423 ACCOUNT_LOCKED), even with the right password', async () => {
    const email = uniqueEmail();
    const { password } = await bootstrapAdmin(h.db.conn, { email, name: 'Ops', adminRoles: ['OPS'] });
    for (let i = 0; i < 4; i++) {
      const r = await login(email, 'wrong-password');
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    const fifth = await login(email, 'wrong-password');
    expect(fifth.status).toBe(423);
    expect(fifth.body.error.code).toBe('ACCOUNT_LOCKED');
    const locked = await login(email, password);
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    const user = await h.db.conn.collection('users').findOne({ email });
    const cred = await creds().findOne({ userId: user!._id });
    const until = new Date(cred!.lockedUntil).getTime();
    expect(until - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(15 * 60_000);
  });

  it('unknown email → 401 INVALID_CREDENTIALS', async () => {
    const r = await login('nobody@thali.test', 'whatever');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('admin login is rate limited per IP+email (10 / 15 min)', async () => {
    const email = 'ratelimited@thali.test';
    for (let i = 0; i < 10; i++) await login(email, 'x');
    const r = await login(email, 'x');
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('RATE_LIMITED');
  });

  it('bootstrap refuses an existing email', async () => {
    const email = uniqueEmail();
    await bootstrapAdmin(h.db.conn, { email, name: 'Ops', adminRoles: ['OPS'] });
    await expect(bootstrapAdmin(h.db.conn, { email, name: 'Ops2', adminRoles: ['OPS'] })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('CLI prints a one-time password; --password-stdin uses the given password; refuses existing email', async () => {
    const out: string[] = [];
    const email = uniqueEmail();
    const code = await runBootstrapAdmin(['--email', email, '--name', 'Ops', '--role', 'SUPER_ADMIN'], {
      conn: h.db.conn,
      write: (s) => out.push(s),
    });
    expect(code).toBe(0);
    const printed = out.join('');
    const match = /One-time password: (\S+)/.exec(printed);
    expect(match).not.toBeNull();
    const l = await login(email, match![1]!);
    expect(l.status).toBe(200);

    const email2 = uniqueEmail();
    const code2 = await runBootstrapAdmin(['--email', email2, '--name', 'Fin', '--role', 'FINANCE', '--password-stdin'], {
      conn: h.db.conn,
      write: () => {},
      readStdin: async () => 'a-very-long-chosen-password\n',
    });
    expect(code2).toBe(0);
    expect((await login(email2, 'a-very-long-chosen-password')).status).toBe(200);

    const errs: string[] = [];
    const code3 = await runBootstrapAdmin(['--email', email2, '--name', 'Dup', '--role', 'OPS'], {
      conn: h.db.conn,
      write: () => {},
      writeErr: (s) => errs.push(s),
    });
    expect(code3).not.toBe(0);
    expect(errs.join('')).toMatch(/exists/i);
  });

  it('POST /admin/admins: SUPER_ADMIN creates an admin (one-time password); OPS is forbidden', async () => {
    const sa = await enrolledAdmin(['SUPER_ADMIN']);
    const saTok = (await fullLogin(sa.email, sa.password, sa.secret)).body.accessToken;
    const email = uniqueEmail();
    const r = await request(h.app)
      .post('/api/v1/admin/admins')
      .set(bearer(saTok))
      .send({ email, name: 'Support', adminRoles: ['SUPPORT'] });
    expect(r.status).toBe(201);
    expect(r.body.user.email).toBe(email);
    expect(r.body.user.adminRoles).toEqual(['SUPPORT']);
    expect(typeof r.body.oneTimePassword).toBe('string');
    expect((await login(email, r.body.oneTimePassword)).body.mfaSetupRequired).toBe(true);
    const audit = await h.db.conn.collection('outbox').findOne({ 'envelope.type': 'audit.recorded', 'envelope.payload.action': 'admin.create' });
    expect(audit).not.toBeNull();

    const ops = await enrolledAdmin(['OPS']);
    const opsTok = (await fullLogin(ops.email, ops.password, ops.secret)).body.accessToken;
    const denied = await request(h.app).post('/api/v1/admin/admins').set(bearer(opsTok)).send({ email: uniqueEmail(), name: 'X', adminRoles: ['OPS'] });
    expect(denied.status).toBe(403);
  });
});
