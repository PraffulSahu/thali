import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptField, encryptField, isEncryptedField } from '@thali/service-kit';

const key = randomBytes(32).toString('base64');

describe('field encryption (LLD 5.6)', () => {
  it('round-trips unicode plaintext', () => {
    const plain = 'A/C 123456789012 — IFSC HDFC0001234 ₹';
    const enc = encryptField(plain, key);
    expect(decryptField(enc, key)).toBe(plain);
  });

  it('uses the v1:<iv>:<tag>:<ct> base64 format with a 12-byte IV and 16-byte tag', () => {
    const enc = encryptField('secret', key);
    expect(enc).toMatch(/^v1:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/);
    const [, iv, tag] = enc.split(':');
    expect(Buffer.from(iv!, 'base64')).toHaveLength(12);
    expect(Buffer.from(tag!, 'base64')).toHaveLength(16);
    expect(isEncryptedField(enc)).toBe(true);
    expect(isEncryptedField('plain')).toBe(false);
  });

  it('uses a fresh IV per encryption', () => {
    expect(encryptField('same', key)).not.toBe(encryptField('same', key));
  });

  it('throws on tampered ciphertext', () => {
    const [v, iv, tag, ct] = encryptField('secret value', key).split(':');
    const bytes = Buffer.from(ct!, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    expect(() => decryptField([v, iv, tag, bytes.toString('base64')].join(':'), key)).toThrow();
  });

  it('throws on tampered tag and on wrong key', () => {
    const enc = encryptField('secret value', key);
    const [v, iv, tag, ct] = enc.split(':');
    const t = Buffer.from(tag!, 'base64');
    t[0] = t[0]! ^ 0x01;
    expect(() => decryptField([v, iv, t.toString('base64'), ct].join(':'), key)).toThrow();
    expect(() => decryptField(enc, randomBytes(32).toString('base64'))).toThrow();
  });

  it('rejects keys that are not 32 bytes and unknown versions', () => {
    expect(() => encryptField('x', randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    const enc = encryptField('x', key);
    expect(() => decryptField(enc.replace(/^v1:/, 'v2:'), key)).toThrow();
    expect(() => decryptField('garbage', key)).toThrow();
  });

  it('accepts a Buffer key', () => {
    const buf = randomBytes(32);
    expect(decryptField(encryptField('b', buf), buf)).toBe('b');
  });
});
