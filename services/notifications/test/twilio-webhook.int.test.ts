import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, oid, TWILIO_URL, twilioSign as sign, type Harness } from './helpers.js';

describe('POST /api/v1/webhooks/twilio/status', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness('twilio_wh');
  });
  afterAll(async () => {
    await h.close();
  });

  const sent = async (sid: string) => {
    const { id } = await h.dispatcher.enqueue({ channel: 'SMS', template: 'order_delivered', to: '+919876543210', data: { code: 'X' }, dedupeKey: `tw:${oid()}` });
    await h.models.Notification.updateOne({ _id: id }, { $set: { status: 'SENT', providerMessageId: sid, provider: 'twilio', attempts: 1 } });
    return id;
  };
  const post = (params: Record<string, string>, opts: { signature?: string | null; url?: string } = {}) => {
    const body = new URLSearchParams(params).toString();
    const sig = opts.signature === undefined ? sign(opts.url ?? TWILIO_URL, params) : opts.signature;
    const r = request(h.app).post('/api/v1/webhooks/twilio/status').type('form');
    if (sig !== null) r.set('x-twilio-signature', sig);
    return r.send(body);
  };

  it('valid signature -> status DELIVERED looked up by providerMessageId', async () => {
    const sid = `SM${oid()}`;
    const id = await sent(sid);
    const res = await post({ MessageSid: sid, MessageStatus: 'delivered', To: '+919876543210', AccountSid: 'AC1' });
    expect(res.status).toBe(204);
    expect(await h.models.Notification.findById(id).lean()).toMatchObject({ status: 'DELIVERED' });
    const cb = await h.models.ProviderCallback.find({ provider: 'twilio' }).lean();
    expect(cb.some((c) => c.verified === true)).toBe(true);
  });

  it('invalid / missing / wrong-URL signature -> 403 and nothing changes', async () => {
    const sid = `SM${oid()}`;
    const id = await sent(sid);
    const params = { MessageSid: sid, MessageStatus: 'delivered' };
    for (const signature of ['AAAA', null, sign(TWILIO_URL, { ...params, MessageStatus: 'failed' }), sign('https://evil.test/x', params)]) {
      const res = await post(params, { signature });
      expect(res.status).toBe(403);
    }
    expect((await h.models.Notification.findById(id).lean())!.status).toBe('SENT');
    expect(await h.models.ProviderCallback.countDocuments({ 'payload.MessageSid': sid })).toBe(0);
  });

  it('replay is safe: identical callback twice -> one stored callback, state stays DELIVERED, both acknowledged', async () => {
    const sid = `SM${oid()}`;
    const id = await sent(sid);
    const params = { MessageSid: sid, MessageStatus: 'delivered' };
    expect((await post(params)).status).toBe(204);
    expect((await post(params)).status).toBe(204);
    expect(await h.models.ProviderCallback.countDocuments({ 'payload.MessageSid': sid })).toBe(1);
    expect((await h.models.Notification.findById(id).lean())!.status).toBe('DELIVERED');
  });

  it('out-of-order callbacks never downgrade (sent after delivered is ignored)', async () => {
    const sid = `SM${oid()}`;
    const id = await sent(sid);
    await post({ MessageSid: sid, MessageStatus: 'delivered' });
    expect((await post({ MessageSid: sid, MessageStatus: 'sent' })).status).toBe(204);
    expect((await post({ MessageSid: sid, MessageStatus: 'failed', ErrorCode: '30006' })).status).toBe(204);
    expect((await h.models.Notification.findById(id).lean())!.status).toBe('DELIVERED');
  });

  it('failed / undelivered -> DEAD with the Twilio error code, never retried automatically', async () => {
    const sid = `SM${oid()}`;
    const id = await sent(sid);
    expect((await post({ MessageSid: sid, MessageStatus: 'undelivered', ErrorCode: '30003' })).status).toBe(204);
    const doc = await h.models.Notification.findById(id).lean();
    expect(doc).toMatchObject({ status: 'DEAD', nextAttemptAt: null });
    expect(doc!.lastError).toContain('30003');
  });

  it('a callback that arrives before the sid is saved is applied once the send completes', async () => {
    const sid = `SM${oid()}`;
    expect((await post({ MessageSid: sid, MessageStatus: 'delivered' })).status).toBe(204); // unknown sid: acknowledged
    const { id } = await h.dispatcher.enqueue({ channel: 'SMS', template: 'order_delivered', to: '+919876543210', data: {}, dedupeKey: `tw:${oid()}` });
    await h.models.Notification.updateOne({ _id: id }, { $set: { status: 'SENDING', attempts: 1 } });
    await h.dispatcher.recordSent(id, { provider: 'twilio', providerMessageId: sid });
    expect((await h.models.Notification.findById(id).lean())!.status).toBe('DELIVERED');
  });

  it('missing MessageSid is a 400 (signed but malformed)', async () => {
    expect((await post({ MessageStatus: 'delivered' })).status).toBe(400);
  });

  it('webhook is disabled (404) when no auth token is configured', async () => {
    const h2 = await createHarness('twilio_wh2', { env: { TWILIO_AUTH_TOKEN: '' } });
    try {
      const res = await request(h2.app).post('/api/v1/webhooks/twilio/status').type('form').set('x-twilio-signature', 'x').send('MessageSid=SM1&MessageStatus=delivered');
      expect(res.status).toBe(404);
    } finally {
      await h2.close();
    }
  });
});
