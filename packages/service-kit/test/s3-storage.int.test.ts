import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createS3Storage, verifyUpload } from '@thali/service-kit';

// MinIO from docker-compose.infra.yml
const storage = createS3Storage({
  endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? 'thali',
  secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'thali-dev-secret',
  publicBucket: 'thali-public',
  publicBaseUrl: 'http://localhost:9000/thali-public',
});
const PRIVATE = 'thali-private';
const PUBLIC = 'thali-public';
const base = `test/${randomBytes(6).toString('hex')}`;
const created: [string, string][] = [];

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function upload(bucket: string, key: string, body: Buffer, contentType: string, maxBytes = 1024) {
  created.push([bucket, key]);
  const p = await storage.presignPut({ bucket, key, contentType, maxBytes });
  return fetch(p.url, { method: 'PUT', headers: p.headers, body });
}

afterAll(async () => {
  for (const [bucket, key] of created) await storage.delete(bucket, key).catch(() => undefined);
});

describe('S3 storage (MinIO)', () => {
  it('presignPut -> PUT bytes -> head returns content type and size; readHead returns leading bytes', async () => {
    const key = `${base}/logo.png`;
    const p = await storage.presignPut({ bucket: PRIVATE, key, contentType: 'image/png', maxBytes: 1024 });
    expect(p.method).toBe('PUT');
    expect(p.headers['content-type']).toBe('image/png');
    expect(new Date(p.expiresAt).getTime()).toBeGreaterThan(Date.now());
    created.push([PRIVATE, key]);
    const res = await fetch(p.url, { method: 'PUT', headers: p.headers, body: PNG });
    expect(res.status).toBe(200);

    expect(await storage.head(PRIVATE, key)).toEqual({ contentType: 'image/png', size: PNG.length });
    const headBytes = await storage.readHead(PRIVATE, key, 8);
    expect(headBytes.equals(PNG.subarray(0, 8))).toBe(true);
  });

  it('presignGet returns the uploaded bytes', async () => {
    const key = `${base}/doc.png`;
    expect((await upload(PRIVATE, key, PNG, 'image/png')).status).toBe(200);
    const g = await storage.presignGet({ bucket: PRIVATE, key, expiresSec: 60 });
    const res = await fetch(g.url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('the signed content type is enforced (different Content-Type -> 403)', async () => {
    const key = `${base}/wrong-type.png`;
    created.push([PRIVATE, key]);
    const p = await storage.presignPut({ bucket: PRIVATE, key, contentType: 'image/png', maxBytes: 1024 });
    const res = await fetch(p.url, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: PNG });
    expect(res.status).toBe(403);
    expect(await storage.head(PRIVATE, key)).toBeNull();
  });

  it('when contentLength is declared it is signed: a different body size is rejected', async () => {
    const key = `${base}/sized.png`;
    created.push([PRIVATE, key]);
    const p = await storage.presignPut({ bucket: PRIVATE, key, contentType: 'image/png', maxBytes: 1024, contentLength: PNG.length });
    expect(p.headers).toEqual({ 'content-type': 'image/png' }); // the client derives Content-Length from the body
    const bad = await fetch(p.url, { method: 'PUT', headers: p.headers, body: Buffer.concat([PNG, Buffer.from('x')]) });
    expect(bad.status).toBe(403);
    const ok = await fetch(p.url, { method: 'PUT', headers: p.headers, body: PNG });
    expect(ok.status).toBe(200);
    await expect(storage.presignPut({ bucket: PRIVATE, key, contentType: 'image/png', maxBytes: 10, contentLength: 11 })).rejects.toMatchObject({
      code: 'FILE_INVALID',
    });
  });

  it('head returns null for a missing object', async () => {
    expect(await storage.head(PRIVATE, `${base}/missing.png`)).toBeNull();
  });

  it('verifyUpload accepts a real PNG and rejects spoofed / oversized / missing uploads', async () => {
    const good = `${base}/good.png`;
    await upload(PRIVATE, good, PNG, 'image/png');
    expect(await verifyUpload(storage, { bucket: PRIVATE, key: good, maxBytes: 1024, allowedTypes: ['image/png', 'image/jpeg'] })).toEqual({
      ok: true,
      contentType: 'image/png',
      size: PNG.length,
    });

    const spoofed = `${base}/spoofed.png`;
    await upload(PRIVATE, spoofed, Buffer.from('<html>not an image</html>'), 'image/png');
    expect(await verifyUpload(storage, { bucket: PRIVATE, key: spoofed, maxBytes: 1024, allowedTypes: ['image/png'] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/content/i),
    });

    expect(await verifyUpload(storage, { bucket: PRIVATE, key: good, maxBytes: 10, allowedTypes: ['image/png'] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/large/i),
    });
    expect(await verifyUpload(storage, { bucket: PRIVATE, key: good, maxBytes: 1024, allowedTypes: ['application/pdf'] })).toMatchObject({
      ok: false,
    });
    expect(await verifyUpload(storage, { bucket: PRIVATE, key: `${base}/none.png`, maxBytes: 1024, allowedTypes: ['image/png'] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not found/i),
    });
  });

  it('publicUrl builds the public bucket URL', async () => {
    const key = `${base}/public.png`;
    await upload(PUBLIC, key, PNG, 'image/png');
    expect(storage.publicUrl(key)).toBe(`http://localhost:9000/thali-public/${key}`);
  });
});
