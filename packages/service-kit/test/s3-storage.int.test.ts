import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createS3Storage, createStorageProvider, verifyUpload } from '@thali/service-kit';

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
  const p = await storage.presignPut({ bucket, key, contentType, maxBytes, contentLength: body.length });
  return fetch(p.url, { method: 'PUT', headers: p.headers, body });
}

afterAll(async () => {
  for (const [bucket, key] of created) await storage.delete(bucket, key).catch(() => undefined);
});

describe('S3 storage (MinIO)', () => {
  it('presignPut -> PUT bytes -> head returns content type and size; readHead returns leading bytes', async () => {
    const key = `${base}/logo.png`;
    const p = await storage.presignPut({ bucket: PRIVATE, key, contentType: 'image/png', maxBytes: 1024, contentLength: PNG.length });
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
    const p = await storage.presignPut({ bucket: PRIVATE, key, contentType: 'image/png', maxBytes: 1024, contentLength: PNG.length });
    const res = await fetch(p.url, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: PNG });
    expect(res.status).toBe(403);
    expect(await storage.head(PRIVATE, key)).toBeNull();
  });

  it('the declared contentLength is required and signed: a different body size is rejected', async () => {
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
    const smaller = await fetch(p.url, { method: 'PUT', headers: p.headers, body: PNG.subarray(0, 10) });
    expect(smaller.status).toBe(403);
    for (const bad of [undefined, 0, -1, 1.5]) {
      await expect(
        storage.presignPut({ bucket: PRIVATE, key, contentType: 'image/png', maxBytes: 1024, contentLength: bad as unknown as number }),
      ).rejects.toMatchObject({ code: 'FILE_INVALID' });
    }
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

  describe('publicEndpoint (server reaches MinIO on a private host, the browser on a public one)', () => {
    // Both hosts reach the same MinIO: 127.0.0.1 plays the private compose hostname (`minio:9000`),
    // localhost the browser-facing one (`localhost:9000`).
    const endpoint = process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000';
    const internal = endpoint.replace('localhost', '127.0.0.1');
    const split = createS3Storage({
      endpoint: internal,
      publicEndpoint: endpoint,
      region: 'us-east-1',
      accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? 'thali',
      secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'thali-dev-secret',
      publicBucket: PUBLIC,
    });

    it('presigned PUT/GET URLs are signed for the public host and work there; head/read go to the internal host', async () => {
      const key = `${base}/split.png`;
      created.push([PRIVATE, key]);
      const p = await split.presignPut({ bucket: PRIVATE, key, contentType: 'image/png', maxBytes: 1024, contentLength: PNG.length });
      expect(new URL(p.url).origin).toBe(new URL(endpoint).origin);
      expect((await fetch(p.url, { method: 'PUT', headers: p.headers, body: PNG })).status).toBe(200);

      expect(await split.head(PRIVATE, key)).toEqual({ contentType: 'image/png', size: PNG.length });
      expect((await split.readHead(PRIVATE, key, 8)).equals(PNG.subarray(0, 8))).toBe(true);

      const g = await split.presignGet({ bucket: PRIVATE, key, expiresSec: 60 });
      expect(new URL(g.url).origin).toBe(new URL(endpoint).origin);
      const res = await fetch(g.url);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    });

    it('a URL presigned for one host is rejected on another (why the public endpoint is needed)', async () => {
      const key = `${base}/hostbound.png`;
      created.push([PRIVATE, key]);
      const p = await split.presignPut({ bucket: PRIVATE, key, contentType: 'image/png', maxBytes: 1024, contentLength: PNG.length });
      const moved = p.url.replace(new URL(endpoint).host, new URL(internal).host);
      expect((await fetch(moved, { method: 'PUT', headers: p.headers, body: PNG })).status).toBe(403);
    });

    it('publicUrl uses publicBaseUrl, else the public endpoint, else the endpoint', () => {
      expect(split.publicUrl('a/b c.png')).toBe(`${endpoint}/${PUBLIC}/a/b%20c.png`);
      const withBase = createS3Storage({ endpoint: internal, publicEndpoint: endpoint, region: 'us-east-1', publicBucket: PUBLIC, publicBaseUrl: 'https://cdn.example/img/' });
      expect(withBase.publicUrl('k.png')).toBe('https://cdn.example/img/k.png');
      const internalOnly = createS3Storage({ endpoint: internal, region: 'us-east-1', publicBucket: PUBLIC });
      expect(internalOnly.publicUrl('k.png')).toBe(`${internal}/${PUBLIC}/k.png`);
    });

    it('createStorageProvider passes S3_PUBLIC_ENDPOINT through (empty = unset)', async () => {
      const cfg = {
        S3_ENDPOINT: internal,
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID ?? 'thali',
        S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'thali-dev-secret',
        S3_PUBLIC_BUCKET: PUBLIC,
      };
      const viaPublic = await createStorageProvider({ ...cfg, S3_PUBLIC_ENDPOINT: endpoint }).presignGet({ bucket: PRIVATE, key: 'x' });
      expect(new URL(viaPublic.url).origin).toBe(new URL(endpoint).origin);
      const viaInternal = await createStorageProvider({ ...cfg, S3_PUBLIC_ENDPOINT: '' }).presignGet({ bucket: PRIVATE, key: 'x' });
      expect(new URL(viaInternal.url).origin).toBe(new URL(internal).origin);
    });
  });
});
