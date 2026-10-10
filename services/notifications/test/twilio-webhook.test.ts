import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { twilioSignature, validateTwilioSignature } from '../src/providers/twilio-sms.js';
import { createHarness, oid, TWILIO_TOKEN, TWILIO_URL, type Harness } from './helpers.js';

/** Independent re-implementation of Twilio's algorithm (fullUrl + sorted key+value, HMAC-SHA1, base64). */
const sign = (url: string, params: Record<string, string>, token = TWILIO_TOKEN) =>
  createHmac('sha1', token)
    .update(url + Object.keys(params).sort().map((k) => k + params[k]).join(''), 'utf8')
    .digest('base64');

describe('twilio signature primitives', () => {
  it('matches the reference vector (twilio-python/-node tests: token 12345)', () => {
    const params = { Digits: '1234', To: '+18005551212', From: '+14158675310', Caller: '+14158675310', CallSid: 'CA1234567890ABCDE' };
    expect(twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', params)).toBe('GvWf1cFY/Q7PnoempGyD5oXAezc=');
  });
  it('validates, tolerates default-port variants of the URL, and rejects tampering', () => {
    const params = { MessageSid: 'SM1', MessageStatus: 'delivered' };
    const good = twilioSignature('t', 'https://h.test/x', params);
    expect(validateTwilioSignature('t', good, 'https://h.test/x', params)).toBe(true);
    expect(validateTwilioSignature('t', good, 'https://h.test:443/x', params)).toBe(true);
    expect(validateTwilioSignature('t', good, 'https://h.test/x', { ...params, MessageStatus: 'failed' })).toBe(false);
    expect(validateTwilioSignature('t', good, 'https://h.test/y', params)).toBe(false);
    expect(validateTwilioSignature('t', good.slice(0, -2), 'https://h.test/x', params)).toBe(false);
    expect(validateTwilioSignature('t', undefined, 'https://h.test/x', params)).toBe(false);
    expect(validateTwilioSignature('other', good, 'https://h.test/x', params)).toBe(false);
  });
  it('duplicate params are sorted and concatenated like twilio-node', () => {
    // each value is appended as name+value, values sorted: ...A1A2B3
    const expected = createHmac('sha1', 't').update('https://h.test/xA1A2B3', 'utf8').digest('base64');
    expect(twilioSignature('t', 'https://h.test/x', { A: ['2', '1'], B: '3' })).toBe(expected);
    expect(twilioSignature('t', 'https://h.test/x', { A: ['2', '1'] })).toBe(twilioSignature('t', 'https://h.test/x', { A: ['1', '2'] }));
  });
});

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
