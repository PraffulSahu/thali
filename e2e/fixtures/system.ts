/**
 * Helpers for the system-level failure-scenario specs (tests/system/*): signed mock webhooks, stopping and
 * restoring a compose service, demo partners (online + fresh location, cleanup, a third approved partner),
 * order users with inline addresses, and admin cleanup of test orders.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { call, ok, partner, waitFor, type ApiRes, type AddressInput, type Json } from './api.js';
import { adminToken } from './admin.js';
import { GEO, REPO_ROOT, sleep } from './env.js';
import { compose, composePs } from './stack.js';

/* ------------------------------------------------------------------ .env */

let envCache: Record<string, string> | null = null;
/** Values from the repo `.env` used by the compose stack (comments and quotes stripped). */
export function dotenv(name: string): string {
  if (!envCache) {
    envCache = {};
    for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      let v = m[2]!.replace(/\s+#.*$/, '').trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      envCache[m[1]!] = v;
    }
  }
  const v = envCache[name];
  if (v === undefined) throw new Error(`${name} missing from .env`);
  return v;
}

/* ------------------------------------------------------------------ mock payment webhooks */

/** Same shape as services/payments/src/routes/demo-pay.ts `paymentEvent()` (Razorpay webhook format). */
export function paymentWebhookBody(event: 'payment.authorized' | 'payment.captured' | 'payment.failed', p: { id: string; orderId: string; amountPaise: number; reason?: string }) {
  const status = event.split('.')[1]!;
  const now = Math.floor(Date.now() / 1000);
  return {
    entity: 'event',
    account_id: 'acc_thali_demo',
    event,
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: p.id,
          entity: 'payment',
          amount: p.amountPaise,
          currency: 'INR',
          status,
          order_id: p.orderId,
          method: 'upi',
          captured: status === 'captured',
          notes: [],
          error_description: p.reason ?? null,
          created_at: now,
        },
      },
    },
    created_at: now,
  };
}

/**
 * POST the exact bytes to /api/v1/webhooks/razorpay, signed like MockProvider.signWebhook
 * (hex HMAC-SHA256 with MOCK_WEBHOOK_SECRET) and flagged with `x-thali-mock`, as the demo path does.
 */
export async function postMockWebhook(raw: string, opts: { eventId?: string; signature?: string } = {}): Promise<ApiRes> {
  const signature = opts.signature ?? createHmac('sha256', dotenv('MOCK_WEBHOOK_SECRET')).update(raw).digest('hex');
  const headers: Record<string, string> = { 'x-razorpay-signature': signature, 'x-thali-mock': '1' };
  if (opts.eventId) headers['x-razorpay-event-id'] = opts.eventId;
  return call('POST', '/webhooks/razorpay', { headers: { ...headers, 'content-type': 'application/json' }, rawBody: raw });
}

/* ------------------------------------------------------------------ compose services */

export async function waitHealthy(service: string, timeoutMs = 120_000): Promise<void> {
  await waitFor(`${service} healthy`, async () => composePs().find((c) => c.Service === service && c.State === 'running' && c.Health === 'healthy') ?? null, {
    timeoutMs,
    intervalMs: 2000,
  });
}
export function stopService(service: string): void {
  compose(['stop', service], { timeoutMs: 90_000 });
}
export async function startService(service: string): Promise<void> {
  compose(['start', service], { timeoutMs: 90_000 });
  await waitHealthy(service);
}

/* ------------------------------------------------------------------ order users */

/** An inline drop address in Koramangala (users without saved addresses can still check out). */
export function dropAddress(label: string, dLat = 0): AddressInput {
  return { label, line1: `${label}, 80 Feet Road, Koramangala`, city: 'Bengaluru', pincode: '560034', location: { lat: GEO.consumer1Home.latitude + dLat, lng: GEO.consumer1Home.longitude } };
}

export const newKey = () => randomUUID();

/* ------------------------------------------------------------------ partners */

/** Go online at `at` and post a fresh location (the dispatcher ignores fixes older than 120 s). */
export async function partnerOnline(token: string, at: { lat: number; lng: number }): Promise<void> {
  ok(await call('POST', '/partner/online', { token, body: at }), 'partner online');
  await pingLocation(token, at);
}
export async function pingLocation(token: string, at: { lat: number; lng: number }): Promise<void> {
  const r = await call('POST', '/partner/location', { token, body: { ...at, accuracyM: 10 } });
  if (r.status === 429) return; // 1 ping / 3 s: the previous one is fresh enough
  ok(r, 'partner location');
}

/** Fail stale active jobs (admin) and decline live offers left by earlier runs. */
export async function resetPartner(token: string): Promise<void> {
  const active = await partner.active(token);
  if (active.length) {
    const admin = await adminToken();
    for (const j of active) await call('POST', `/admin/delivery/jobs/${j.id}/fail`, { token: admin, body: { reason: 'e2e cleanup: stale test delivery' } });
  }
  for (const o of await partner.offers(token)) if (o.status === 'OFFERED') await partner.rejectOffer(token, o.id);
}

/**
 * Wait for `token`'s OFFERED offer for `childOrderId`, declining offers for other jobs and keeping the
 * location fresh meanwhile.
 */
export async function waitForOffer(
  token: string,
  childOrderId: string,
  at: { lat: number; lng: number },
  opts: { keep?: string[]; timeoutMs?: number } = {},
): Promise<Json> {
  // a declined job is never offered to this partner again, so offers for jobs in `keep` are left alone
  const keep = new Set([childOrderId, ...(opts.keep ?? [])]);
  return waitFor(`offer for ${childOrderId}`, async () => {
    const offers = await partner.offers(token);
    for (const o of offers) if (o.status === 'OFFERED' && !keep.has(o.job?.childOrderId)) await partner.rejectOffer(token, o.id);
    const hit = offers.find((o: Json) => o.status === 'OFFERED' && o.job?.childOrderId === childOrderId);
    if (!hit) await pingLocation(token, at);
    return hit ?? null;
  }, { timeoutMs: opts.timeoutMs ?? 150_000, intervalMs: 3100 });
}

function tinyPdf(title: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% ${title}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1'));
}

/**
 * Make the signed-in user an APPROVED delivery partner (idempotent): profile (bicycle: only ID proof needed)
 * -> ID proof PDF via presigned PUT -> submit -> admin approve. Used to get a third loginable partner, since
 * only two seeded partners have demo phones.
 */
export async function ensureApprovedPartner(token: string, name: string): Promise<Json> {
  let r = await call('GET', '/partner/profile', { token });
  if (r.status === 404) r = await call('POST', '/partner/profile', { token, body: { name, vehicle: { type: 'BICYCLE', registrationNumber: 'CYCLE-E2E' } } });
  let profile = ok(r, 'partner profile');
  if (profile.status === 'APPROVED') return profile;
  if (profile.status === 'DRAFT') {
    if (!profile.vehicle) profile = ok(await call('PATCH', '/partner/profile', { token, body: { vehicle: { type: 'BICYCLE', registrationNumber: 'CYCLE-E2E' } } }), 'partner vehicle');
    if (!(profile.documents ?? []).some((d: Json) => d.type === 'ID_PROOF')) {
      const pdf = tinyPdf(`ID proof ${name}`);
      const pre = ok(await call('POST', '/partner/uploads', { token, body: { type: 'ID_PROOF', contentType: 'application/pdf', sizeBytes: pdf.length } }), 'partner presign');
      const put = await fetch(pre.upload.url, { method: 'PUT', headers: pre.upload.headers, body: pdf });
      if (put.status >= 300) throw new Error(`ID proof upload: HTTP ${put.status}`);
      ok(await call('POST', '/partner/documents', { token, body: { type: 'ID_PROOF', key: pre.key } }), 'attach ID proof');
    }
    profile = ok(await call('POST', '/partner/submit', { token }), 'partner submit');
  }
  if (profile.status === 'APPROVAL_PENDING') {
    const admin = await adminToken();
    ok(await call('POST', `/admin/delivery/partners/${profile.id}/approve`, { token: admin, body: {} }), 'admin approve partner');
    profile = ok(await call('GET', '/partner/profile', { token }), 'partner profile');
  }
  if (profile.status !== 'APPROVED') throw new Error(`partner ${name} is ${profile.status}`);
  return profile;
}

/** Admin: cancel a child order with a full refund (cleanup of orders a scenario leaves in flight). */
export async function adminCancelChild(childId: string, refundPaise: number, reason = 'e2e cleanup'): Promise<ApiRes> {
  const admin = await adminToken();
  return call('POST', `/admin/orders/child/${childId}/cancel`, { token: admin, body: { reason, refundPaise } });
}

export { sleep };
