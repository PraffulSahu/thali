import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import { seedId } from '@thali/contracts/seed';
import { decryptField } from '@thali/service-kit';
import { createTestDb, type TestDb } from '@thali/service-kit/testing';
import { initIdentityDb } from '../src/db.js';
import { models } from '../src/models/index.js';
import { DEFAULT_DEMO_ADMIN_PASSWORD, DEFAULT_DEMO_ADMIN_TOTP_SECRET, seedIdentity } from '../src/seed.js';

let db: TestDb;
const key = Buffer.alloc(32, 9).toString('base64');
beforeAll(async () => {
  db = await createTestDb('identity_seed');
  await initIdentityDb(db.conn);
});
afterAll(async () => {
  await db.drop();
});

describe('seedIdentity', () => {
  it('demo users + admin (password + enabled TOTP), all isDemo; idempotent', async () => {
    const first = await seedIdentity(db.conn, { fieldEncryptionKey: key, log: () => undefined });
    expect(first).toEqual({ users: { inserted: 10, existing: 0 }, admin_credentials: { inserted: 1, existing: 0 } });
    const { User, AdminCredential } = models(db.conn);
    expect(await User.countDocuments({ isDemo: { $ne: true } })).toBe(0);
    const admin = (await User.findById(seedId('user:admin')).lean())!;
    expect(admin).toMatchObject({ email: 'admin@thali.demo', roles: ['CONSUMER', 'ADMIN'], adminRoles: ['SUPER_ADMIN'] });
    const cred = (await AdminCredential.findOne({ userId: admin._id }).lean())!;
    expect(await argon2.verify(cred.passwordHash, DEFAULT_DEMO_ADMIN_PASSWORD)).toBe(true);
    expect(cred.totpEnabled).toBe(true);
    expect(decryptField(cred.totpSecretEnc!, key)).toBe(DEFAULT_DEMO_ADMIN_TOTP_SECRET);

    const second = await seedIdentity(db.conn, { fieldEncryptionKey: key, log: () => undefined });
    expect(second).toEqual({ users: { inserted: 0, existing: 10 }, admin_credentials: { inserted: 0, existing: 1 } });
  });
});
