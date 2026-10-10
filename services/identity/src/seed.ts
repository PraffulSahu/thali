/**
 * Identity demo seed (APP_MODE=demo only; idempotent; writes only thali_identity).
 *
 *   container:  docker compose exec identity node dist/seed.js
 *   local:      npm run seed -w @thali/identity        (MONGO_URI, FIELD_ENCRYPTION_KEY from env)
 *
 * Ids come from `seedId()` so other services' seeds reference the same users:
 *   user:consumer1..3 (+91900000000{1,2,3}), user:owner1..2 (+91910000000{1,2}),
 *   user:partner1..4 (+91920000000{1..4}; 1-2 are DEMO_PHONES), user:admin (admin@thali.demo).
 * The admin gets a known demo password and an enabled TOTP secret, both printed (demo only).
 */
import { authenticator } from 'otplib';
import type { Connection } from 'mongoose';
import { seedId } from '@thali/contracts/seed';
import { encryptField } from '@thali/service-kit';
import { ensureDocs, isMainModule, runSeedCli, type SeedReport } from '@thali/service-kit/seed';
import { initIdentityDb } from './db.js';
import { hashPassword } from './domain/admin-auth.js';
import { models } from './models/index.js';

export const DEMO_ADMIN_EMAIL = 'admin@thali.demo';
/** Demo-only credentials (printed by the seed). Override with SEED_ADMIN_PASSWORD / SEED_ADMIN_TOTP_SECRET. */
export const DEFAULT_DEMO_ADMIN_PASSWORD = 'ThaliDemo#2026';
export const DEFAULT_DEMO_ADMIN_TOTP_SECRET = 'THALIDEMOTOTPSECRETKEY234567ABCD'; // base32, 20 bytes

/** Koramangala, Bengaluru (inside the demo service area seeded by marketplace). */
const home = (key: string, line1: string, lat: number, lng: number, label = 'Home') => ({
  _id: seedId(`address:${key}`),
  label,
  line1,
  city: 'Bengaluru',
  pincode: '560034',
  location: { type: 'Point', coordinates: [lng, lat] },
  isDefault: true,
});

const user = (key: string, phone: string, name: string, roles: string[], extra: Record<string, unknown> = {}) => ({
  _id: seedId(`user:${key}`),
  phone,
  name,
  roles,
  adminRoles: [],
  status: 'ACTIVE',
  isDemo: true,
  ...extra,
});

export function identitySeedUsers() {
  return [
    user('consumer1', '+919000000001', 'Asha Rao', ['CONSUMER'], {
      email: 'asha@thali.demo',
      addresses: [home('consumer1:home', '42, 4th Block, 80 Feet Road, Koramangala', 12.9338, 77.6309)],
    }),
    user('consumer2', '+919000000002', 'Vikram Shah', ['CONSUMER'], {
      addresses: [home('consumer2:home', '7, 6th Block, Koramangala', 12.9391, 77.6197)],
    }),
    user('consumer3', '+919000000003', 'Meera Iyer', ['CONSUMER'], {
      addresses: [home('consumer3:home', '19, 1st Block, Koramangala', 12.9279, 77.6346)],
    }),
    user('owner1', '+919100000001', 'Ravi Kumar', ['CONSUMER', 'RESTAURANT_OWNER'], { email: 'ravi.owner@thali.demo' }),
    user('owner2', '+919100000002', 'Sunita Menon', ['CONSUMER', 'RESTAURANT_OWNER'], { email: 'sunita.owner@thali.demo' }),
    user('partner1', '+919200000001', 'Arjun Singh', ['CONSUMER', 'DELIVERY_PARTNER']),
    user('partner2', '+919200000002', 'Kiran Das', ['CONSUMER', 'DELIVERY_PARTNER']),
    user('partner3', '+919200000003', 'Farhan Ali', ['CONSUMER', 'DELIVERY_PARTNER']),
    user('partner4', '+919200000004', 'Deepak Yadav', ['CONSUMER', 'DELIVERY_PARTNER']),
  ];
}

export interface IdentitySeedOptions {
  fieldEncryptionKey: string;
  adminPassword?: string;
  adminTotpSecret?: string;
  log?: (s: string) => void;
}

export async function seedIdentity(conn: Connection, opts: IdentitySeedOptions): Promise<SeedReport> {
  const { User, AdminCredential } = models(conn);
  const report: SeedReport = {};
  const password = opts.adminPassword ?? DEFAULT_DEMO_ADMIN_PASSWORD;
  const totpSecret = opts.adminTotpSecret ?? DEFAULT_DEMO_ADMIN_TOTP_SECRET;
  const log = opts.log ?? ((s: string) => process.stdout.write(s));

  await ensureDocs(User, [
    ...identitySeedUsers(),
    {
      _id: seedId('user:admin'),
      email: DEMO_ADMIN_EMAIL,
      name: 'Demo Admin',
      roles: ['CONSUMER', 'ADMIN'],
      adminRoles: ['SUPER_ADMIN'],
      status: 'ACTIVE',
      isDemo: true,
    },
  ], report);

  const adminCredId = seedId('admin-credential:admin');
  const credExisted = !!(await AdminCredential.exists({ _id: adminCredId }));
  await ensureDocs(
    AdminCredential,
    [
      {
        _id: adminCredId,
        userId: seedId('user:admin'),
        passwordHash: credExisted ? 'unused' : await hashPassword(password),
        totpSecretEnc: encryptField(totpSecret, opts.fieldEncryptionKey),
        totpEnabled: true,
      },
    ],
    report,
  );

  log(
    [
      '',
      '  DEMO ADMIN (demo mode only — never use these outside a local demo)',
      `    email        ${DEMO_ADMIN_EMAIL}`,
      `    password     ${credExisted ? '(unchanged; set when first seeded — default ' + DEFAULT_DEMO_ADMIN_PASSWORD + ')' : password}`,
      `    TOTP secret  ${totpSecret}`,
      `    otpauth URI  ${authenticator.keyuri(DEMO_ADMIN_EMAIL, 'Thali', totpSecret)}`,
      `    current code ${authenticator.generate(totpSecret)}`,
      '  Demo OTP 123456 works for DEMO_PHONES: consumers +91900000000{1,2,3}, owners +91910000000{1,2}, partners +91920000000{1,2}',
      '',
      '',
    ].join('\n'),
  );
  return report;
}

if (isMainModule(import.meta.url)) {
  void runSeedCli({
    service: 'identity',
    dbName: process.env.IDENTITY_DB_NAME ?? 'thali_identity',
    init: initIdentityDb,
    run: (conn) => {
      const key = process.env.FIELD_ENCRYPTION_KEY;
      if (!key) throw new Error('FIELD_ENCRYPTION_KEY is required');
      return seedIdentity(conn, {
        fieldEncryptionKey: key,
        ...(process.env.SEED_ADMIN_PASSWORD ? { adminPassword: process.env.SEED_ADMIN_PASSWORD } : {}),
        ...(process.env.SEED_ADMIN_TOTP_SECRET ? { adminTotpSecret: process.env.SEED_ADMIN_TOTP_SECRET } : {}),
      });
    },
  });
}
