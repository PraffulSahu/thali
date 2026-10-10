import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { twilioSignature, validateTwilioSignature } from '../src/providers/twilio-sms.js';

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
