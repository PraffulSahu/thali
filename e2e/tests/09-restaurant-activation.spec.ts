/**
 * Flow 9: business email verification and administrator approval control restaurant activation.
 * An owner registers a new restaurant (API: profile, hours, settlement, KYC PDFs uploaded to MinIO through
 * presigned URLs, submit). It cannot be approved or found until the business email is verified via the link
 * in the real email (Mailpit), and it goes live only after an admin approves it in the admin console.
 */
import { expect, test } from '@playwright/test';
import { call, login, ok, type Json } from '../fixtures/api.js';
import { adminToken, adminUiLogin } from '../fixtures/admin.js';
import { PHONES, runTag } from '../fixtures/env.js';
import { signInViaPage } from '../fixtures/otp.js';
import { waitForEmail } from '../fixtures/stack.js';
import { newRoleContext, selectRestaurant } from '../fixtures/ui.js';

test.setTimeout(300_000);

const LOCATION = { lat: 12.9301, lng: 77.6282 }; // Koramangala, inside the demo service area

function tinyPdf(title: string): Buffer {
  const body = `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% ${title}\ntrailer << /Root 1 0 R >>\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

test('restaurant goes live only after email verification and admin approval', async ({ browser }) => {
  const owner = await login('owner2');
  const admin = await adminToken();
  const tag = runTag();
  const name = `E2E Kitchen ${tag}`;
  const businessEmail = `${tag}@kitchen.e2e.test`;

  // ---- owner registers (API)
  const cuisines = ok(await call('GET', '/cuisines'), 'GET /cuisines');
  const cuisine = (Array.isArray(cuisines) ? cuisines : cuisines.items)[0].slug as string;
  const created = ok(
    await call('POST', '/owner/restaurants', {
      token: owner.token,
      body: {
        name,
        businessName: `${name} Pvt Ltd`,
        description: 'Created by the e2e suite (flow 9).',
        cuisines: [cuisine],
        phone: '+919876543210',
        businessEmail,
        address: { line1: '21, 3rd Block, Koramangala', city: 'Bengaluru', pincode: '560034' },
        location: LOCATION,
        deliveryRadiusKm: 6,
        avgPrepMinutes: 20,
      },
    }),
    'POST /owner/restaurants',
  );
  const r = created.restaurant ?? created;
  const id: string = r.id;
  ok(await call('PUT', `/owner/restaurants/${id}/hours`, { token: owner.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '00:00' })) } }), 'PUT hours');
  ok(await call('PUT', `/owner/restaurants/${id}/settlement`, { token: owner.token, body: { accountHolder: 'E2E Kitchen', accountNumber: '123456789012', ifsc: 'HDFC0001234' } }), 'PUT settlement');
  for (const type of ['FSSAI', 'GST', 'PAN']) {
    const pdf = tinyPdf(`${type} ${tag}`);
    const pre = ok(await call('POST', `/owner/restaurants/${id}/uploads`, { token: owner.token, body: { purpose: 'DOCUMENT', contentType: 'application/pdf', sizeBytes: pdf.length } }), 'presign');
    const put = await fetch(pre.upload.url, { method: 'PUT', headers: pre.upload.headers, body: new Uint8Array(pdf) });
    expect(put.status, `PUT ${type} to storage`).toBeLessThan(300);
    ok(await call('POST', `/owner/restaurants/${id}/documents`, { token: owner.token, body: { type, key: pre.key } }), `attach ${type}`);
  }
  const since = new Date();
  const submitted = ok(await call('POST', `/owner/restaurants/${id}/submit`, { token: owner.token }), 'submit');
  expect(submitted.status).toBe('VERIFICATION_PENDING');

  // ---- gate 1: unverified email -> admin cannot approve, not discoverable
  const early = await call('POST', `/admin/marketplace/restaurants/${id}/approve`, { token: admin, body: {} });
  expect(early.status, JSON.stringify(early.body)).toBe(409);
  expect(early.body.error.code).toBe('RESTAURANT_INVALID_TRANSITION');
  const discoNames = async () =>
    (ok(await call('GET', `/discovery/restaurants?lat=${LOCATION.lat}&lng=${LOCATION.lng}`), 'discovery').items as Json[]).map((x) => x.name);
  expect(await discoNames()).not.toContain(name);

  const o = await newRoleContext(browser);
  const a = await newRoleContext(browser);
  try {
    // owner dashboard: "verify your business email"
    await signInViaPage(o.page, PHONES.owner2, '/restaurant');
    await selectRestaurant(o.page, id);
    await expect(o.page.getByText('Verify your business email')).toBeVisible();
    await expect(o.page.getByRole('main')).toContainText(businessEmail);

    // ---- the verification email (Mailpit) -> link -> back in the web app
    const mail = await waitForEmail(businessEmail, { since, timeoutMs: 90_000 });
    const link = (mail.text + mail.html).match(/https?:\/\/[^\s"'<>]+\/api\/v1\/restaurants\/verify-email\?token=[A-Za-z0-9_-]+/)?.[0];
    expect(link, `verification link in "${mail.subject}"`).toBeTruthy();
    await o.page.goto(link!);
    await expect(o.page).toHaveURL(/\/restaurant\/onboarding\?.*emailVerified=1/);
    await expect(o.page.getByRole('heading', { name: 'Business email verified' })).toBeVisible();
    const verified = ok(await call('GET', `/owner/restaurants/${id}`, { token: owner.token }), 'GET own restaurant');
    expect(verified.status).toBe('APPROVAL_PENDING');
    expect(verified.emailVerified).toBe(true);
    expect(await discoNames()).not.toContain(name); // still needs approval

    await o.page.goto('/restaurant');
    await expect(o.page.getByText('Our team is reviewing your restaurant')).toBeVisible();

    // ---- gate 2: admin approves in the console
    await adminUiLogin(a.page, `/admin/restaurants?status=APPROVAL_PENDING&q=${encodeURIComponent(name)}`);
    await expect(a.page.getByRole('heading', { name: 'Restaurants', level: 1 })).toBeVisible();
    await expect(a.page.getByRole('region', { name: 'Restaurants' })).toContainText(name);
    await a.page.goto(`/admin/restaurants/${id}`);
    await expect(a.page.getByRole('heading', { name, level: 1 })).toBeVisible();
    // the "Business email" detail shows this restaurant's address with the Verified badge
    const emailRow = a.page.getByRole('definition').filter({ hasText: businessEmail });
    await expect(emailRow).toHaveCount(1);
    await expect(emailRow.getByText('Verified', { exact: true })).toBeVisible();
    await expect(emailRow.getByText('Not verified', { exact: true })).toHaveCount(0);
    await a.page.getByRole('button', { name: 'Approve', exact: true }).click();
    await a.page.getByRole('alertdialog', { name: `Approve ${name}?` }).getByRole('button', { name: 'Approve' }).click();
    await expect(a.page.getByText('Approved', { exact: true }).first()).toBeVisible();

    // ---- live: API status, discovery, owner dashboard
    const live = ok(await call('GET', `/admin/marketplace/restaurants/${id}`, { token: admin }), 'admin GET restaurant');
    expect(live.status).toBe('APPROVED');
    await expect.poll(discoNames, { timeout: 30_000 }).toContain(name);
    await o.page.reload();
    await expect(o.page.getByRole('button', { name: new RegExp(`^Switch restaurant\\. Current: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first()).toBeVisible();
    await expect(o.page.getByText('Our team is reviewing your restaurant')).toBeHidden();
    await expect(o.page.getByText('Verify your business email')).toBeHidden();
  } finally {
    // keep the demo discovery list clean: take the test restaurant offline again
    await call('POST', `/admin/marketplace/restaurants/${id}/suspend`, { token: admin, body: { reason: 'e2e cleanup: test restaurant' } }).catch(() => undefined);
    await o.context.close();
    await a.context.close();
  }
});
