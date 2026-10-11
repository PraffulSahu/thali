/**
 * Identity slice of the Bengaluru dataset (`@thali/contracts/seed-blr`): 1,000 consumers (+91910…, 1-3
 * addresses with locality + formattedAddress), ~450 restaurant owners (+91920…) and 250 delivery partners
 * (+91930…), Indian names, gender-matched avatars (`avatarKey`: mirrored bucket key or allowlisted URL).
 * Demo OTP 123456 works for all of them through DEMO_PHONE_PREFIXES (demo mode). Bulk + idempotent.
 */
import type { Connection } from 'mongoose';
import type { BlrAddress, BlrUserBase, BlrWorld } from '@thali/contracts/seed-blr';
import { ensureDocsBulk, type SeedReport } from '@thali/service-kit/seed';
import { models } from './models/index.js';

const address = (a: BlrAddress) => ({
  _id: a.id,
  label: a.label,
  line1: a.line1,
  ...(a.line2 ? { line2: a.line2 } : {}),
  locality: a.locality,
  formattedAddress: a.formattedAddress,
  city: a.city,
  pincode: a.pincode,
  location: { type: 'Point', coordinates: [a.location.lng, a.location.lat] },
  isDefault: a.isDefault,
});

function userDoc(w: BlrWorld, u: BlrUserBase, roles: string[], addresses: BlrAddress[] = []) {
  const createdAt = w.daysAgo(u.createdDaysAgo, -600);
  return {
    _id: u.id,
    phone: u.phone,
    name: u.name,
    ...(u.email ? { email: u.email } : {}),
    roles,
    adminRoles: [],
    status: 'ACTIVE',
    addresses: addresses.map(address),
    avatarKey: u.avatarKey,
    isDemo: true,
    createdAt,
    updatedAt: createdAt,
  };
}

export async function seedIdentityBlr(conn: Connection, w: BlrWorld): Promise<SeedReport> {
  const { User } = models(conn);
  const report: SeedReport = {};
  const label = 'users (blr)';
  await ensureDocsBulk(User, (function* () {
    for (const c of w.consumers) yield userDoc(w, c, ['CONSUMER'], c.addresses);
    for (const o of w.owners) yield userDoc(w, o, ['CONSUMER', 'RESTAURANT_OWNER']);
    for (const p of w.partners) yield userDoc(w, p, ['CONSUMER', 'DELIVERY_PARTNER']);
  })(), report, { label });
  return report;
}
