import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { decodeJwt } from 'jose';
import { Types } from 'mongoose';
const ObjectId = Types.ObjectId;
import {
  bearer,
  createHarness,
  isRevoked,
  loginWithOtp,
  randomPhone,
  rawSetCookie,
  refreshCookie,
  withCsrf,
  type Harness,
} from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness('refresh', { OTP_RESEND_COOLDOWN_SEC: '0' });
});
afterAll(async () => {
  await h?.close();
});

const sessions = () => h.db.conn.collection('sessions');
const refresh = (cookie: string | null) => {
  const t = withCsrf(request(h.app).post('/api/v1/auth/refresh'));
  return cookie ? t.set('Cookie', cookie) : t;
};

describe('POST /auth/refresh', () => {
  it('rotates the cookie and returns a new access token for the same session', async () => {
    const login = await loginWithOtp(h.app, h, randomPhone());
    const r = await refresh(login.cookie);
    expect(r.status).toBe(200);
    expect(typeof r.body.accessToken).toBe('string');
    const next = refreshCookie(r);
    expect(next).toBeTruthy();
    expect(next).not.toBe(login.cookie);
    expect(rawSetCookie(r)).toMatch(/HttpOnly/i);
    expect(decodeJwt(r.body.accessToken).sid).toBe(login.sid);
    // the new cookie works
    const r2 = await refresh(next);
    expect(r2.status).toBe(200);
    // /me works with the new access token
    expect((await request(h.app).get('/api/v1/me').set(bearer(r.body.accessToken))).status).toBe(200);
  });

  it('old cookie re-presented within the grace window → current access token, no rotation (multi-tab race)', async () => {
    const login = await loginWithOtp(h.app, h, randomPhone());
    const r1 = await refresh(login.cookie);
    const next = refreshCookie(r1)!;
    const raced = await refresh(login.cookie);
    expect(raced.status).toBe(200);
    expect(raced.body.accessToken).toBeTruthy();
    expect(refreshCookie(raced)).toBeNull();
    expect((await refresh(next)).status).toBe(200);
  });

  it('old cookie reused after grace → 401 SESSION_REUSE_DETECTED and the family is revoked', async () => {
    const login = await loginWithOtp(h.app, h, randomPhone());
    const r1 = await refresh(login.cookie);
    const next = refreshCookie(r1)!;
    await sessions().updateOne({ _id: new ObjectId(login.sid) }, { $set: { rotatedAt: new Date(Date.now() - 60_000) } });

    const reuse = await refresh(login.cookie);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('SESSION_REUSE_DETECTED');

    const after = await refresh(next);
    expect(after.status).toBe(401);
    expect(await isRevoked(h, login.sid)).toBe(true);
    const me = await request(h.app).get('/api/v1/me').set(bearer(r1.body.accessToken));
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_REVOKED');
  });

  it('a hash two rotations old is also detected as reuse', async () => {
    const login = await loginWithOtp(h.app, h, randomPhone());
    const c1 = refreshCookie(await refresh(login.cookie))!;
    await sessions().updateOne({ _id: new ObjectId(login.sid) }, { $set: { rotatedAt: new Date(Date.now() - 60_000) } });
    const c2 = refreshCookie(await refresh(c1))!;
    expect(c2).toBeTruthy();
    const reuse = await refresh(login.cookie);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('SESSION_REUSE_DETECTED');
    expect((await refresh(c2)).status).toBe(401);
  });

  it('missing X-Requested-With → 403 CSRF_CHECK_FAILED', async () => {
    const login = await loginWithOtp(h.app, h, randomPhone());
    const r = await request(h.app).post('/api/v1/auth/refresh').set('Origin', 'http://localhost:5173').set('Cookie', login.cookie);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CSRF_CHECK_FAILED');
  });

  it('disallowed or missing Origin → 403 CSRF_CHECK_FAILED', async () => {
    const login = await loginWithOtp(h.app, h, randomPhone());
    const bad = await withCsrf(request(h.app).post('/api/v1/auth/refresh'), 'https://evil.example').set('Cookie', login.cookie);
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe('CSRF_CHECK_FAILED');
    const none = await request(h.app).post('/api/v1/auth/refresh').set('X-Requested-With', 'thali-web').set('Cookie', login.cookie);
    expect(none.status).toBe(403);
    expect(none.body.error.code).toBe('CSRF_CHECK_FAILED');
  });

  it('no cookie → 401 UNAUTHENTICATED', async () => {
    const r = await refresh(null);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('unknown cookie → 401', async () => {
    const r = await refresh('thali_rt=not-a-real-token-value-xxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(r.status).toBe(401);
  });

  it('blocked user cannot refresh', async () => {
    const login = await loginWithOtp(h.app, h, randomPhone());
    await h.db.conn.collection('users').updateOne({ _id: new ObjectId(login.userId) }, { $set: { status: 'BLOCKED' } });
    const r = await refresh(login.cookie);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ACCOUNT_BLOCKED');
  });

  it('refreshed access token reflects current roles', async () => {
    const login = await loginWithOtp(h.app, h, randomPhone());
    await h.db.conn.collection('users').updateOne({ _id: new ObjectId(login.userId) }, { $addToSet: { roles: 'RESTAURANT_OWNER' } });
    const r = await refresh(login.cookie);
    expect(decodeJwt(r.body.accessToken).roles).toEqual(['CONSUMER', 'RESTAURANT_OWNER']);
  });
});

describe('logout', () => {
  it('POST /auth/logout → revoked:sid:<sid> set in Redis, cookie cleared, refresh 401', async () => {
    const login = await loginWithOtp(h.app, h, randomPhone());
    const r = await withCsrf(request(h.app).post('/api/v1/auth/logout')).set('Cookie', login.cookie);
    expect(r.status).toBe(204);
    expect(rawSetCookie(r)).toMatch(/thali_rt=;/);
    expect(await isRevoked(h, login.sid)).toBe(true);
    const ttl = await h.tr.redis.ttl(`${h.tr.prefix}revoked:sid:${login.sid}`);
    expect(ttl).toBeGreaterThan(800);
    expect(ttl).toBeLessThanOrEqual(900);
    const again = await refresh(login.cookie);
    expect(again.status).toBe(401);
    const me = await request(h.app).get('/api/v1/me').set(bearer(login.accessToken));
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_REVOKED');
  });

  it('logout requires the CSRF header', async () => {
    const login = await loginWithOtp(h.app, h, randomPhone());
    const r = await request(h.app).post('/api/v1/auth/logout').set('Origin', 'http://localhost:5173').set('Cookie', login.cookie);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CSRF_CHECK_FAILED');
  });

  it('logout without a cookie is a no-op 204', async () => {
    const r = await withCsrf(request(h.app).post('/api/v1/auth/logout'));
    expect(r.status).toBe(204);
  });

  it('POST /auth/logout-all revokes every session of the user', async () => {
    const phone = randomPhone();
    const a = await loginWithOtp(h.app, h, phone);
    const b = await loginWithOtp(h.app, h, phone);
    expect(a.sid).not.toBe(b.sid);
    const r = await request(h.app).post('/api/v1/auth/logout-all').set(bearer(a.accessToken));
    expect(r.status).toBe(204);
    expect(await isRevoked(h, a.sid)).toBe(true);
    expect(await isRevoked(h, b.sid)).toBe(true);
    expect((await refresh(a.cookie)).status).toBe(401);
    expect((await refresh(b.cookie)).status).toBe(401);
  });

  it('logout-all requires authentication', async () => {
    expect((await request(h.app).post('/api/v1/auth/logout-all')).status).toBe(401);
  });
});
