import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@thali/service-kit';
import { ProviderSendError } from '../src/providers/errors.js';
import { TwilioSmsProvider } from '../src/providers/twilio-sms.js';
import { ResendEmailProvider } from '../src/providers/resend-email.js';
import { MailpitEmailProvider, parseAddress } from '../src/providers/mailpit-email.js';
import { MockSmsProvider } from '../src/providers/mock-sms.js';
import { MockEmailProvider } from '../src/providers/mock-email.js';
import { isRetryable, nextDelaySec } from '../src/domain/retry.js';
import { LogCapture } from './helpers.js';

const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const stub = (res: Response | (() => Response | Promise<Response>)) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => (typeof res === 'function' ? res() : res.clone()));
const initOf = (f: ReturnType<typeof stub>) => f.mock.calls[0]![1] as RequestInit & { headers: Record<string, string> };

describe('TwilioSmsProvider', () => {
  const base = { accountSid: 'AC00000000000000000000000000000001', authToken: 'tok_secret', timeoutMs: 2000 };

  it('POSTs form-encoded To/From/Body/StatusCallback to Accounts/{SID}/Messages.json with basic auth SID:token', async () => {
    const f = stub(jsonRes(201, { sid: 'SM123', status: 'queued' }));
    const p = new TwilioSmsProvider({ ...base, from: '+15005550006', fetch: f });
    const out = await p.send({ to: '+919876543210', body: 'Hello', notificationId: 'n1', statusCallbackUrl: 'https://api.thali.test/api/v1/webhooks/twilio/status' });
    expect(out).toEqual({ providerMessageId: 'SM123' });
    expect(String(f.mock.calls[0]![0])).toBe(`https://api.twilio.com/2010-04-01/Accounts/${base.accountSid}/Messages.json`);
    const init = initOf(f);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from(`${base.accountSid}:${base.authToken}`).toString('base64')}`);
    const form = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(form)).toEqual({
      To: '+919876543210', From: '+15005550006', Body: 'Hello', StatusCallback: 'https://api.thali.test/api/v1/webhooks/twilio/status',
    });
  });

  it('uses MessagingServiceSid instead of From when configured, and omits StatusCallback when none', async () => {
    const f = stub(jsonRes(201, { sid: 'SM9' }));
    await new TwilioSmsProvider({ ...base, messagingServiceSid: 'MG123', fetch: f }).send({ to: '+919876543210', body: 'x', notificationId: 'n' });
    const form = new URLSearchParams(String(initOf(f).body));
    expect(form.get('MessagingServiceSid')).toBe('MG123');
    expect(form.has('From')).toBe(false);
    expect(form.has('StatusCallback')).toBe(false);
  });

  it('classifies errors: 400 invalid number permanent; 429/5xx/network/timeout retryable; message has no body/phone/token', async () => {
    const mk = (res: Response | (() => Response | Promise<Response>)) => new TwilioSmsProvider({ ...base, from: '+1', fetch: stub(res) as never });
    const send = (p: TwilioSmsProvider) => p.send({ to: '+919876543210', body: 'secret body 482910', notificationId: 'n' });

    const e400 = await send(mk(jsonRes(400, { code: 21211, message: "The 'To' number +919876543210 is not a valid phone number.", status: 400, more_info: 'https://www.twilio.com/docs/errors/21211' }))).catch((e) => e);
    expect(e400).toBeInstanceOf(ProviderSendError);
    expect(e400).toMatchObject({ retryable: false, status: 400, code: '21211', provider: 'twilio' });
    expect(e400.message).not.toContain('+919876543210');
    expect(e400.message).not.toContain('482910');

    expect(await send(mk(jsonRes(429, { code: 20429, message: 'Too many requests', status: 429 }))).catch((e) => e)).toMatchObject({ retryable: true, status: 429 });
    expect(await send(mk(jsonRes(503, { message: 'down' }))).catch((e) => e)).toMatchObject({ retryable: true, status: 503 });
    expect(await send(mk(new Response('<html>bad gateway</html>', { status: 502 }))).catch((e) => e)).toMatchObject({ retryable: true, status: 502 });
    expect(await send(mk(() => { throw new TypeError('fetch failed'); })).catch((e) => e)).toMatchObject({ retryable: true });
    expect(await send(mk(jsonRes(201, { status: 'queued' }))).catch((e) => e)).toMatchObject({ retryable: true }); // 2xx without sid
    const timeout = new TwilioSmsProvider({ ...base, from: '+1', timeoutMs: 30, fetch: ((_u: unknown, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)))) as never });
    expect(await send(timeout).catch((e) => e)).toMatchObject({ retryable: true });
  });
});

describe('ResendEmailProvider', () => {
  const msg = { to: 'asha@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', idempotencyKey: 'evt-1:EMAIL:abc', notificationId: 'n1' };

  it('POSTs JSON {from,to,subject,html,text} to /emails with bearer auth and Idempotency-Key = dedupeKey', async () => {
    const f = stub(jsonRes(200, { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }));
    const p = new ResendEmailProvider({ apiKey: 're_key', from: 'Thali <no-reply@thali.test>', fetch: f as never, timeoutMs: 2000 });
    expect(await p.send(msg)).toEqual({ providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });
    expect(String(f.mock.calls[0]![0])).toBe('https://api.resend.com/emails');
    const init = initOf(f);
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer re_key');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers['idempotency-key']).toBe('evt-1:EMAIL:abc');
    expect(JSON.parse(String(init.body))).toEqual({ from: 'Thali <no-reply@thali.test>', to: ['asha@example.com'], subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' });
  });

  it('classifies errors', async () => {
    const mk = (res: Response) => new ResendEmailProvider({ apiKey: 'k', from: 'a@b.co', fetch: stub(res) as never });
    expect(await mk(jsonRes(422, { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' })).send(msg).catch((e) => e)).toMatchObject({ retryable: false, status: 422, provider: 'resend' });
    expect(await mk(jsonRes(429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'slow down' })).send(msg).catch((e) => e)).toMatchObject({ retryable: true });
    expect(await mk(jsonRes(500, { statusCode: 500, name: 'application_error', message: 'oops' })).send(msg).catch((e) => e)).toMatchObject({ retryable: true });
    expect(await mk(jsonRes(409, { statusCode: 409, name: 'concurrent_idempotent_requests', message: 'in flight' })).send(msg).catch((e) => e)).toMatchObject({ retryable: true });
    expect(await mk(jsonRes(200, {})).send(msg).catch((e) => e)).toMatchObject({ retryable: true });
  });
});

describe('MailpitEmailProvider', () => {
  it('parseAddress handles "Name <a@b>" and bare addresses', () => {
    expect(parseAddress('Thali <no-reply@thali.local>')).toEqual({ Email: 'no-reply@thali.local', Name: 'Thali' });
    expect(parseAddress('a@b.co')).toEqual({ Email: 'a@b.co' });
    expect(parseAddress('"Thali, Inc" <x@y.z>')).toEqual({ Email: 'x@y.z', Name: 'Thali, Inc' });
  });

  it('POSTs the Mailpit send payload (From/To objects, Subject, Text, HTML, Tags) to /api/v1/send', async () => {
    const f = stub(jsonRes(200, { ID: 'mp-1' }));
    const p = new MailpitEmailProvider({ baseUrl: 'http://localhost:8025/', from: 'Thali <no-reply@thali.local>', fetch: f as never });
    const out = await p.send({ to: 'asha@example.com', subject: 'S', html: '<b>x</b>', text: 'x', idempotencyKey: 'k', notificationId: 'n' });
    expect(out).toEqual({ providerMessageId: 'mp-1' });
    expect(String(f.mock.calls[0]![0])).toBe('http://localhost:8025/api/v1/send');
    expect(initOf(f).method).toBe('POST');
    expect(JSON.parse(String(initOf(f).body))).toEqual({
      From: { Email: 'no-reply@thali.local', Name: 'Thali' },
      To: [{ Email: 'asha@example.com' }],
      Subject: 'S', Text: 'x', HTML: '<b>x</b>', Tags: ['thali'],
    });
  });

  it('connection refused is retryable; 400 is permanent', async () => {
    const down = new MailpitEmailProvider({ baseUrl: 'http://localhost:8025', from: 'a@b.co', fetch: (async () => { throw new TypeError('fetch failed'); }) as never });
    expect(await down.send({ to: 'a@b.co', subject: 's', text: 't', html: 'h', idempotencyKey: 'k', notificationId: 'n' }).catch((e) => e)).toMatchObject({ retryable: true });
    const bad = new MailpitEmailProvider({ baseUrl: 'http://localhost:8025', from: 'a@b.co', fetch: stub(jsonRes(400, { Error: 'bad' })) as never });
    expect(await bad.send({ to: 'x', subject: 's', text: 't', html: 'h', idempotencyKey: 'k', notificationId: 'n' }).catch((e) => e)).toMatchObject({ retryable: false });
  });
});

describe('mock providers (demo only)', () => {
  const mkLog = () => {
    const out = new LogCapture();
    return { out, logger: createLogger('t', { level: 'debug', destination: out }) };
  };
  it('log "[DEMO] would send", return a mock id, and never log the body or the full recipient', async () => {
    const { out, logger } = mkLog();
    const sms = new MockSmsProvider({ logger });
    const r = await sms.send({ to: '+919876543210', body: 'Your code is 482910', notificationId: 'n1' });
    expect(r.providerMessageId).toMatch(/^mock-/);
    expect(sms.name).toBe('mock');
    const email = new MockEmailProvider({ logger });
    await email.send({ to: 'asha@example.com', subject: 'Reset', text: 'https://x/?token=SECRET', html: '', idempotencyKey: 'k', notificationId: 'n2' });
    expect(out.text).toContain('[DEMO] would send');
    expect(out.text).not.toContain('482910');
    expect(out.text).not.toContain('SECRET');
    expect(out.text).not.toContain('+919876543210');
    expect(out.text).not.toContain('asha@example.com');
  });
  it('fail mode makes them throw a retryable 503', async () => {
    const { logger } = mkLog();
    const sms = new MockSmsProvider({ logger, failMode: { get: async () => ({ sms: true, email: false }) } });
    const email = new MockEmailProvider({ logger, failMode: { get: async () => ({ sms: true, email: false }) } });
    expect(await sms.send({ to: '+919876543210', body: 'x', notificationId: 'n' }).catch((e) => e)).toMatchObject({ retryable: true, status: 503 });
    await expect(email.send({ to: 'a@b.co', subject: 's', text: 't', html: 'h', idempotencyKey: 'k', notificationId: 'n' })).resolves.toBeTruthy();
    const both = new MockEmailProvider({ logger, failMode: { get: async () => ({ sms: false, email: true }) } });
    expect(await both.send({ to: 'a@b.co', subject: 's', text: 't', html: 'h', idempotencyKey: 'k', notificationId: 'n' }).catch((e) => e)).toMatchObject({ retryable: true, status: 503 });
  });
});

describe('retry policy', () => {
  it('delay is base * 2^(attempt-1), capped', () => {
    expect([1, 2, 3, 4, 5].map((a) => nextDelaySec(a, 30, 900))).toEqual([30, 60, 120, 240, 480]);
    expect(nextDelaySec(6, 30, 900)).toBe(900);
    expect(nextDelaySec(60, 30, 900)).toBe(900);
  });
  it('isRetryable: ProviderSendError flag wins; unknown errors are retryable', () => {
    expect(isRetryable(new ProviderSendError('twilio', 'x', { retryable: false, status: 400 }))).toBe(false);
    expect(isRetryable(new ProviderSendError('twilio', 'x', { retryable: true, status: 503 }))).toBe(true);
    expect(isRetryable(new Error('boom'))).toBe(true);
  });
});
