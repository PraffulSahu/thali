import { describe, expect, it } from 'vitest';
import { verifySvixSignature } from '../src/providers/resend-email.js';
import { RESEND_SECRET, svixHeaders as svix } from './fixtures.js';

describe('verifySvixSignature', () => {
  const body = '{"type":"email.delivered"}';
  const now = Date.now();
  it('accepts valid, multi-signature headers and rejects bad ones', () => {
    const hd = svix(body);
    const args = { secret: RESEND_SECRET, id: hd['svix-id'], timestamp: hd['svix-timestamp'], body, now };
    expect(verifySvixSignature({ ...args, signature: hd['svix-signature'] })).toBe(true);
    expect(verifySvixSignature({ ...args, signature: `v1,AAAA ${hd['svix-signature']}` })).toBe(true);
    expect(verifySvixSignature({ ...args, signature: 'v1,AAAA' })).toBe(false);
    expect(verifySvixSignature({ ...args, signature: hd['svix-signature'].replace('v1,', 'v2,') })).toBe(false);
    expect(verifySvixSignature({ ...args, signature: hd['svix-signature'], body: `${body} ` })).toBe(false);
    expect(verifySvixSignature({ ...args, signature: hd['svix-signature'], secret: `whsec_${Buffer.from('other-secret-bytes').toString('base64')}` })).toBe(false);
  });
  it('rejects timestamps older or newer than 5 minutes, and non-numeric ones', () => {
    const old = svix(body, { ts: Math.floor(now / 1000) - 301 });
    expect(verifySvixSignature({ secret: RESEND_SECRET, id: old['svix-id'], timestamp: old['svix-timestamp'], signature: old['svix-signature'], body, now })).toBe(false);
    const edge = svix(body, { ts: Math.floor(now / 1000) - 299 });
    expect(verifySvixSignature({ secret: RESEND_SECRET, id: edge['svix-id'], timestamp: edge['svix-timestamp'], signature: edge['svix-signature'], body, now })).toBe(true);
    const future = svix(body, { ts: Math.floor(now / 1000) + 400 });
    expect(verifySvixSignature({ secret: RESEND_SECRET, id: future['svix-id'], timestamp: future['svix-timestamp'], signature: future['svix-signature'], body, now })).toBe(false);
    expect(verifySvixSignature({ secret: RESEND_SECRET, id: 'a', timestamp: 'abc', signature: 'v1,x', body, now })).toBe(false);
  });
});
