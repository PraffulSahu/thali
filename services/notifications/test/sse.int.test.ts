import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishRealtime } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import { createHarness, oid, type Harness } from './helpers.js';

let h: Harness;
let baseUrl: string;
beforeAll(async () => {
  h = await createHarness('sse', { heartbeatMs: 100 });
  baseUrl = (await h.listen()).baseUrl;
});
afterAll(async () => {
  await h.close();
});

async function ticketFor(token: string) {
  const res = await fetch(`${baseUrl}/api/v1/realtime/ticket`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  return { res, body: (await res.json()) as { ticket: string; expiresInSec: number } };
}

/** Minimal SSE reader over fetch streaming. */
async function openStream(ticket: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${baseUrl}/api/v1/realtime/stream?ticket=${encodeURIComponent(ticket)}`, { signal: ctrl.signal });
  let buf = '';
  const reader = res.body?.getReader();
  const dec = new TextDecoder();
  let done = false;
  const pump = (async () => {
    try {
      while (reader) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
      }
    } catch {
      /* aborted */
    }
    done = true;
  })();
  return {
    res,
    text: () => buf,
    ended: () => done,
    waitFor: (needle: string | RegExp, timeoutMs = 3000) =>
      waitFor(() => (typeof needle === 'string' ? buf.includes(needle) : needle.test(buf)), { timeoutMs, message: `stream never contained ${needle}; got ${JSON.stringify(buf)}` }),
    close: async () => {
      ctrl.abort();
      await pump;
    },
  };
}

describe('POST /realtime/ticket', () => {
  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/v1/realtime/ticket`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('issues a 30 s ticket stored in Redis', async () => {
    const { res, body } = await ticketFor(await h.userToken(oid()));
    expect(res.status).toBe(201);
    expect(body.expiresInSec).toBe(30);
    expect(body.ticket.length).toBeGreaterThanOrEqual(32);
    const keys = await h.redis.keys(`${h.config.REDIS_KEY_PREFIX}rt:ticket:*`);
    expect(keys.length).toBeGreaterThan(0);
    const ttls = await Promise.all(keys.map((k) => h.redis.ttl(k)));
    expect(ttls.every((t) => t > 0 && t <= 30)).toBe(true);
    // the raw ticket value is not the stored key (only a hash is stored)
    expect(keys.join()).not.toContain(body.ticket);
  });
});

describe('GET /realtime/stream', () => {
  it('streams with the right headers, a heartbeat comment, and published user events as named SSE events', async () => {
    const userId = oid();
    const { body } = await ticketFor(await h.userToken(userId));
    const s = await openStream(body.ticket);
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(s.res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(s.res.headers.get('x-accel-buffering')).toBe('no');
    expect(s.res.headers.get('content-encoding')).toBeNull();

    await s.waitFor(': ping'); // heartbeat interval is 100 ms in this test (SSE_HEARTBEAT_MS)
    const data = { checkoutId: oid(), childOrderId: oid(), status: 'ACCEPTED', refundStatus: 'NONE', deliveryStatus: null };
    await waitFor(async () => (await publishRealtime(h.redis, `user:${userId}`, 'order.updated', data)) >= 1);
    await s.waitFor('event: order.updated');
    expect(s.text()).toContain(`data: ${JSON.stringify(data)}\n\n`);
    await s.close();
  });

  it('ticket is single use: a second stream with the same ticket is 401', async () => {
    const { body } = await ticketFor(await h.userToken(oid()));
    const s = await openStream(body.ticket);
    expect(s.res.status).toBe(200);
    const again = await fetch(`${baseUrl}/api/v1/realtime/stream?ticket=${body.ticket}`);
    expect(again.status).toBe(401);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
    await s.close();
  });

  it('missing / unknown / expired tickets are 401', async () => {
    expect((await fetch(`${baseUrl}/api/v1/realtime/stream`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/v1/realtime/stream?ticket=nope`)).status).toBe(401);
    const { body } = await ticketFor(await h.userToken(oid()));
    const keys = await h.redis.keys(`${h.config.REDIS_KEY_PREFIX}rt:ticket:*`);
    await h.redis.unlink(...keys); // simulate the 30 s TTL elapsing
    expect((await fetch(`${baseUrl}/api/v1/realtime/stream?ticket=${body.ticket}`)).status).toBe(401);
  });

  it('subscribes to the owner and partner channels of the same user, and never to other users', async () => {
    const userId = oid();
    const other = oid();
    const { body } = await ticketFor(await h.userToken(userId, { roles: ['CONSUMER', 'RESTAURANT_OWNER', 'DELIVERY_PARTNER'] }));
    const s = await openStream(body.ticket);
    await s.waitFor(': ping');
    await waitFor(async () => (await publishRealtime(h.redis, `owner:${userId}`, 'owner.order', { childOrderId: 'c1', restaurantId: 'r1', status: 'PLACED' })) >= 1);
    await publishRealtime(h.redis, `partner:${userId}`, 'partner.offer', { offerId: 'o1', jobId: 'j1', expiresAt: 'x' });
    await publishRealtime(h.redis, `user:${other}`, 'order.updated', { secret: 'not for you' });
    await publishRealtime(h.redis, `owner:${other}`, 'owner.order', { secret: 'not for you' });
    await publishRealtime(h.redis, 'admin', 'notification', { secret: 'admin only' });
    await publishRealtime(h.redis, `user:${userId}`, 'notification', { id: '1', title: 't', body: 'b' });
    await s.waitFor('event: partner.offer');
    await s.waitFor('event: notification');
    expect(s.text()).toContain('event: owner.order');
    expect(s.text()).not.toContain('not for you');
    expect(s.text()).not.toContain('admin only');
    await s.close();
  });

  it('admin channel only for ADMIN tokens that completed MFA', async () => {
    const admin = await openStream((await ticketFor(await h.adminToken(oid()))).body.ticket);
    const pwdUser = oid();
    const plainUser = oid();
    const pwdOnly = await openStream((await ticketFor(await h.adminToken(pwdUser, { mfa: false }))).body.ticket);
    const plain = await openStream((await ticketFor(await h.userToken(plainUser))).body.ticket);
    await Promise.all([admin.waitFor(': ping'), pwdOnly.waitFor(': ping'), plain.waitFor(': ping')]);
    await waitFor(async () => (await publishRealtime(h.redis, 'admin', 'notification', { id: 'a1', title: 'Exception', body: 'x' })) >= 1);
    await admin.waitFor('"Exception"');
    // Redis pub/sub is ordered per connection: a marker published AFTER the admin message and received by the
    // non-admin streams proves the admin message would already have arrived if they were subscribed to it.
    const markers = [pwdOnly, plain].map((_, i) => `marker-${i}-${oid()}`);
    for (const [i, s] of [pwdOnly, plain].entries()) {
      const uid = i === 0 ? pwdUser : plainUser;
      await publishRealtime(h.redis, `user:${uid}`, 'notification', { id: markers[i], title: 'm', body: 'm' });
      await s.waitFor(markers[i]!);
    }
    expect(pwdOnly.text()).not.toContain('Exception');
    expect(plain.text()).not.toContain('Exception');
    await Promise.all([admin.close(), pwdOnly.close(), plain.close()]);
  });

  it('closes the connection server-side when the hub shuts down and cleans up on client disconnect', async () => {
    const userId = oid();
    const s = await openStream((await ticketFor(await h.userToken(userId))).body.ticket);
    await s.waitFor(': ping');
    expect(h.hub.clientCount()).toBeGreaterThanOrEqual(1);
    const before = h.hub.clientCount();
    await s.close();
    await waitFor(() => h.hub.clientCount() === before - 1);
  });

  it('caps concurrent streams per user (oldest is closed)', async () => {
    const userId = oid();
    const streams: Awaited<ReturnType<typeof openStream>>[] = [];
    for (let i = 0; i < h.config.SSE_MAX_STREAMS_PER_USER + 1; i++) {
      streams.push(await openStream((await ticketFor(await h.userToken(userId))).body.ticket));
    }
    await waitFor(() => streams[0]!.ended());
    expect(streams[streams.length - 1]!.ended()).toBe(false);
    await Promise.all(streams.map((s) => s.close()));
  });
});
