/**
 * Field-level encryption (LLD 5.6): AES-256-GCM, output `v1:<iv b64>:<tag b64>:<ct b64>`
 * (standard base64, 12-byte random IV, 16-byte tag). Key = `FIELD_ENCRYPTION_KEY`, base64 of 32 bytes.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const FORMAT = /^v1:([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]*={0,2})$/;

function toKey(key: string | Buffer): Buffer {
  const buf = typeof key === 'string' ? Buffer.from(key, 'base64') : key;
  if (buf.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must be base64 of exactly 32 bytes');
  return buf;
}

export function encryptField(plaintext: string, key: string | Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', toKey(key), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Decrypt a `v1:` value; throws on wrong key, tampering or unknown format. */
export function decryptField(value: string, key: string | Buffer): string {
  const m = FORMAT.exec(value);
  if (!m) throw new Error('Unsupported encrypted field format');
  const iv = Buffer.from(m[1]!, 'base64');
  const tag = Buffer.from(m[2]!, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Unsupported encrypted field format');
  const decipher = createDecipheriv('aes-256-gcm', toKey(key), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(m[3]!, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Field decryption failed');
  }
}

export function isEncryptedField(value: unknown): value is string {
  return typeof value === 'string' && FORMAT.test(value);
}
