import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createHarness, type Harness } from './helpers.js';

// Real MinIO from docker-compose.infra.yml (buckets thali-public / thali-private).
let h: Harness;
let token: string;
let rid: string;
const cleanup: [string, string][] = [];

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

beforeAll(async () => {
  h = await createHarness('uploads');
  token = await h.ownerToken();
  rid = (await request(h.app).post('/api/v1/owner/restaurants').set(bearer(token)).send({ name: 'Upload Co' })).body.restaurant.id;
});
afterAll(async () => {
  for (const [bucket, key] of cleanup) await h.storage.delete(bucket, key).catch(() => undefined);
  await h?.close();
});

async function presign(body: Record<string, unknown>) {
  return request(h.app).post(`/api/v1/owner/restaurants/${rid}/uploads`).set(bearer(token)).send(body);
}

async function put(upload: { url: string; headers: Record<string, string> }, bytes: Buffer) {
  return fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes });
}

describe('uploads (presign → PUT → verify on attach)', () => {
  it('document: presign → PUT a PNG → attach OK (private bucket)', async () => {
    const p = await presign({ purpose: 'DOCUMENT', contentType: 'image/png', sizeBytes: PNG.length });
    expect(p.status).toBe(201);
    expect(p.body.key).toMatch(new RegExp(`^restaurants/${rid}/documents/[a-f0-9-]+\\.png$`));
    expect(p.body.bucket).toBe('private');
    expect(p.body.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' }, maxBytes: 5 * 1024 * 1024 });
    cleanup.push(['thali-private', p.body.key]);
    expect((await put(p.body.upload, PNG)).status).toBe(200);

    const a = await request(h.app).post(`/api/v1/owner/restaurants/${rid}/documents`).set(bearer(token)).send({ type: 'FSSAI', key: p.body.key });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ type: 'FSSAI', key: p.body.key, verified: false });
    expect(a.body.id).toMatch(/^[a-f0-9]{24}$/);

    // re-attaching the same type replaces the previous document
    const p2 = await presign({ purpose: 'DOCUMENT', contentType: 'application/pdf', sizeBytes: PDF.length });
    cleanup.push(['thali-private', p2.body.key]);
    expect((await put(p2.body.upload, PDF)).status).toBe(200);
    await request(h.app).post(`/api/v1/owner/restaurants/${rid}/documents`).set(bearer(token)).send({ type: 'FSSAI', key: p2.body.key }).expect(201);
    const r = await request(h.app).get(`/api/v1/owner/restaurants/${rid}`).set(bearer(token));
    expect(r.body.documents).toEqual([expect.objectContaining({ type: 'FSSAI', key: p2.body.key })]);

    // admin gets a short-lived signed URL
    const admin = await h.adminToken();
    const docId = r.body.documents[0].id;
    const u = await request(h.app).get(`/api/v1/admin/marketplace/restaurants/${rid}/documents/${docId}/url`).set(bearer(admin));
    expect(u.status).toBe(200);
    expect(new Date(u.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    const fetched = await fetch(u.body.url);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(PDF)).toBe(true);
    const v = await request(h.app).post(`/api/v1/admin/marketplace/restaurants/${rid}/documents/${docId}/verify`).set(bearer(admin));
    expect(v.status).toBe(200);
    expect(v.body.verified).toBe(true);
  });

  it('a text file labelled image/png → 422 FILE_INVALID and the object is deleted', async () => {
    const text = Buffer.from('hello, I am definitely not a png file');
    const p = await presign({ purpose: 'DOCUMENT', contentType: 'image/png', sizeBytes: text.length });
    cleanup.push(['thali-private', p.body.key]);
    expect((await put(p.body.upload, text)).status).toBe(200);
    const a = await request(h.app).post(`/api/v1/owner/restaurants/${rid}/documents`).set(bearer(token)).send({ type: 'GST', key: p.body.key });
    expect(a.status).toBe(422);
    expect(a.body.error.code).toBe('FILE_INVALID');
    expect(await h.storage.head('thali-private', p.body.key)).toBeNull();
  });

  it('oversized or disallowed type → 422 at presign', async () => {
    const big = await presign({ purpose: 'IMAGE', contentType: 'image/png', sizeBytes: 2 * 1024 * 1024 + 1 });
    expect(big.status).toBe(422);
    expect(big.body.error.code).toBe('FILE_INVALID');
    const bigDoc = await presign({ purpose: 'DOCUMENT', contentType: 'application/pdf', sizeBytes: 5 * 1024 * 1024 + 1 });
    expect(bigDoc.status).toBe(422);
    const pdfImage = await presign({ purpose: 'IMAGE', contentType: 'application/pdf', sizeBytes: 100 });
    expect(pdfImage.status).toBe(422);
    const gif = await presign({ purpose: 'DOCUMENT', contentType: 'image/gif', sizeBytes: 100 });
    expect(gif.status).toBe(422);
  });

  it('object larger than the limit (uploaded out of band) → 422 at attach, object deleted', async () => {
    const key = `restaurants/${rid}/documents/oversize.pdf`;
    cleanup.push(['thali-private', key]);
    const huge = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
    const p = await h.storage.presignPut({ bucket: 'thali-private', key, contentType: 'application/pdf', maxBytes: huge.length * 2, contentLength: huge.length });
    expect((await put(p, huge)).status).toBe(200);
    const a = await request(h.app).post(`/api/v1/owner/restaurants/${rid}/documents`).set(bearer(token)).send({ type: 'PAN', key });
    expect(a.status).toBe(422);
    expect(a.body.error.code).toBe('FILE_INVALID');
    expect(await h.storage.head('thali-private', key)).toBeNull();
  });

  it('image: presign (public bucket) → PUT → set as cover via PATCH → public URL in views', async () => {
    const p = await presign({ purpose: 'IMAGE', contentType: 'image/png', sizeBytes: PNG.length });
    expect(p.status).toBe(201);
    expect(p.body.bucket).toBe('public');
    expect(p.body.key).toMatch(new RegExp(`^restaurants/${rid}/images/`));
    cleanup.push(['thali-public', p.body.key]);
    expect((await put(p.body.upload, PNG)).status).toBe(200);
    const patch = await request(h.app).patch(`/api/v1/owner/restaurants/${rid}`).set(bearer(token)).send({ images: { cover: p.body.key } });
    expect(patch.status).toBe(200);
    expect(patch.body.images.coverUrl).toBe(`http://localhost:9000/thali-public/${p.body.key}`);

    // a missing object cannot be set as an image
    const missing = await request(h.app)
      .patch(`/api/v1/owner/restaurants/${rid}`)
      .set(bearer(token))
      .send({ images: { logo: `restaurants/${rid}/images/missing.png` } });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('FILE_INVALID');
  });
});
