/** Real Mailpit (docker-compose.infra.yml, http://localhost:8025): proves the HTTP send payload is accepted. */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { waitFor } from '@thali/service-kit/testing';
import { MailpitEmailProvider } from '../src/providers/mailpit-email.js';

const MAILPIT = process.env.TEST_MAILPIT_URL ?? 'http://localhost:8025';
const sentIds: string[] = [];

afterAll(async () => {
  if (sentIds.length) {
    await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ IDs: sentIds }) });
  }
});

describe('MailpitEmailProvider against a live Mailpit', () => {
  it('delivers an email visible through the Mailpit API with From/To/Subject/Text/HTML intact', async () => {
    const provider = new MailpitEmailProvider({ baseUrl: MAILPIT, from: 'Thali <no-reply@thali.local>' });
    const subject = `thali-test ${randomUUID()}`;
    const out = await provider.send({
      to: 'owner@resto.example',
      subject,
      text: 'Verify: https://thali.test/verify?token=abc&x=1',
      html: '<p>Verify: <a href="https://thali.test/verify?token=abc&amp;x=1">link</a></p>',
      idempotencyKey: 'k-1',
      notificationId: 'n-1',
    });
    expect(out.providerMessageId).toMatch(/\S+/);
    sentIds.push(out.providerMessageId);

    let msg: any;
    await waitFor(async () => {
      const res = await fetch(`${MAILPIT}/api/v1/message/${out.providerMessageId}`);
      if (!res.ok) return false;
      msg = await res.json();
      return true;
    });
    expect(msg.Subject).toBe(subject);
    expect(msg.From).toMatchObject({ Address: 'no-reply@thali.local', Name: 'Thali' });
    expect(msg.To).toEqual([expect.objectContaining({ Address: 'owner@resto.example' })]);
    expect(msg.Text).toContain('https://thali.test/verify?token=abc&x=1');
    expect(msg.HTML).toContain('<a href="https://thali.test/verify?token=abc&amp;x=1">');
    expect(msg.Tags).toContain('thali');
  });

  it('surfaces a rejected payload as a permanent ProviderSendError (400 from Mailpit)', async () => {
    const provider = new MailpitEmailProvider({ baseUrl: MAILPIT, from: 'Thali <no-reply@thali.local>' });
    const err = await provider.send({ to: '', subject: 's', text: 't', html: 'h', idempotencyKey: 'k', notificationId: 'n' }).catch((e) => e);
    expect(err).toMatchObject({ name: 'ProviderSendError', retryable: false });
  });

  it('is reported as a retryable failure when Mailpit is unreachable', async () => {
    const provider = new MailpitEmailProvider({ baseUrl: 'http://127.0.0.1:1', from: 'a@b.co', timeoutMs: 500 });
    const err = await provider.send({ to: 'a@b.co', subject: 's', text: 't', html: 'h', idempotencyKey: 'k', notificationId: 'n' }).catch((e) => e);
    expect(err).toMatchObject({ retryable: true });
  });
});
