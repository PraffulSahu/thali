/**
 * Admin authentication (HLD §5, LLD §5.3): argon2id password (m=19 MiB, t=2, p=1) + TOTP.
 *
 * - No public registration: admins come from the bootstrap CLI or `POST /admin/admins` (SUPER_ADMIN).
 * - Login: lockout after ADMIN_MAX_FAILED_ATTEMPTS (5) failures for ADMIN_LOCK_MINUTES (15) → 423.
 *   TOTP enabled → `{ mfaRequired, mfaToken }` (5 min, aud `mfa`); otherwise a password-only access
 *   token (amr=[pwd], no refresh cookie) usable only for `/auth/admin/mfa/setup|enable`.
 * - TOTP: otplib authenticator, ±1 step window; the accepted step is stored (`lastTotpStep`) and any
 *   step ≤ it is rejected (replay protection, including the code used to enable).
 */
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import type { Connection, Types } from 'mongoose';
import { DomainError, type AdminRole } from '@thali/contracts';
import { auditEvent, decryptField, encryptField, withTransaction } from '@thali/service-kit';
import type { Ctx } from '../deps.js';
import { models } from '../models/index.js';
import type { AdminCredentialDoc } from '../models/admin-credential.js';
import type { UserDoc } from '../models/user.js';
import { createSession, type ClientMeta, type CreatedSession } from './sessions.js';

export const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
export const MIN_ADMIN_PASSWORD_LENGTH = 12;
const TOTP_STEP_SEC = 30;
const TOTP_WINDOW = 1;

export const hashPassword = (password: string) => argon2.hash(password, ARGON2_OPTIONS);
export const generatePassword = () => randomBytes(18).toString('base64url');

let dummyHash: Promise<string> | undefined;
/** Burn comparable time for unknown emails so response time doesn't reveal which emails are admins. */
async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(generatePassword());
  await argon2.verify(await dummyHash, password).catch(() => false);
}

/** Accepted TOTP step for `code`, or null. */
export function totpStep(secret: string, code: string, at = Date.now()): number | null {
  const delta = authenticator.clone({ window: TOTP_WINDOW, epoch: at }).checkDelta(code, secret);
  if (delta === null) return null;
  return Math.floor(at / 1000 / TOTP_STEP_SEC) + delta;
}

export interface CreateAdminInput {
  email: string;
  name: string;
  adminRoles: AdminRole[];
  password?: string;
}
export interface AdminActor {
  actorId: string;
  actorRole: string;
  ip?: string;
}

/**
 * Create an admin user + credential (bootstrap CLI and `POST /admin/admins`). Refuses an existing
 * email (409 CONFLICT). Returns the (generated or given) password exactly once.
 */
export async function bootstrapAdmin(
  conn: Connection,
  input: CreateAdminInput,
  actor: AdminActor = { actorId: 'SYSTEM', actorRole: 'SYSTEM' },
): Promise<{ userId: string; password: string; user: UserDoc }> {
  const { User, AdminCredential } = models(conn);
  const email = input.email.trim().toLowerCase();
  if (!input.adminRoles.length) throw new DomainError('VALIDATION_FAILED', 'At least one admin role is required');
  if (input.password !== undefined && input.password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new DomainError('VALIDATION_FAILED', `Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`);
  }
  const exists = () => new DomainError('CONFLICT', `A user with email ${email} already exists`);
  if (await User.exists({ email })) throw exists();

  const password = input.password ?? generatePassword();
  const passwordHash = await hashPassword(password);
  try {
    const user = await withTransaction(conn, async (session) => {
      const [u] = await User.create(
        [{ email, name: input.name.trim(), roles: ['CONSUMER', 'ADMIN'], adminRoles: [...new Set(input.adminRoles)] }],
        { session },
      );
      await AdminCredential.create([{ userId: u!._id, passwordHash }], { session });
      await auditEvent(conn, session, {
        service: 'identity',
        actorId: actor.actorId,
        actorRole: actor.actorRole,
        action: 'admin.create',
        targetType: 'user',
        targetId: String(u!._id),
        summary: `Created admin ${email} (${input.adminRoles.join(', ')})`,
        ...(actor.ip ? { ip: actor.ip } : {}),
      });
      return u!.toObject() as UserDoc;
    });
    return { userId: String(user._id), password, user };
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw exists();
    throw e;
  }
}

const invalidCredentials = () => new DomainError('INVALID_CREDENTIALS', 'Invalid email or password');
const lockedError = (until: Date) =>
  new DomainError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', undefined, { lockedUntil: until.toISOString() });

function assertNotLocked(cred: AdminCredentialDoc): void {
  if (cred.lockedUntil && cred.lockedUntil.getTime() > Date.now()) throw lockedError(cred.lockedUntil);
}

/** Count a failed password/TOTP attempt; locks the account when the threshold is reached (throws 423). */
async function registerFailure(ctx: Ctx, cred: AdminCredentialDoc): Promise<void> {
  const { AdminCredential } = ctx.m;
  const after = await AdminCredential.findOneAndUpdate({ _id: cred._id }, { $inc: { failedAttempts: 1 } }, { new: true }).lean();
  if (after && after.failedAttempts >= ctx.config.ADMIN_MAX_FAILED_ATTEMPTS) {
    const until = new Date(Date.now() + ctx.config.ADMIN_LOCK_MINUTES * 60_000);
    await AdminCredential.updateOne({ _id: cred._id }, { $set: { lockedUntil: until, failedAttempts: 0 } });
    ctx.logger.warn({ userId: String(cred.userId) }, 'admin account locked after repeated failures');
    throw lockedError(until);
  }
}

async function loadAdmin(ctx: Ctx, userId: Types.ObjectId | string): Promise<{ user: UserDoc; cred: AdminCredentialDoc }> {
  const user = await ctx.m.User.findById(userId).lean<UserDoc>();
  const cred = user ? await ctx.m.AdminCredential.findOne({ userId: user._id }).lean<AdminCredentialDoc>() : null;
  if (!user || !cred || !user.roles.includes('ADMIN')) throw new DomainError('UNAUTHENTICATED', 'Admin session invalid');
  return { user, cred };
}

export type AdminLoginResult =
  | { kind: 'mfa'; mfaToken: string }
  | { kind: 'setup'; user: UserDoc; session: CreatedSession };

export async function adminLogin(ctx: Ctx, email: string, password: string, meta: ClientMeta): Promise<AdminLoginResult> {
  const { User, AdminCredential } = ctx.m;
  const user = await User.findOne({ email: email.trim().toLowerCase(), roles: 'ADMIN' }).lean<UserDoc>();
  const cred = user ? await AdminCredential.findOne({ userId: user._id }).lean<AdminCredentialDoc>() : null;
  if (!user || !cred) {
    await burnPasswordCheck(password);
    throw invalidCredentials();
  }
  assertNotLocked(cred);
  const ok = await argon2.verify(cred.passwordHash, password).catch(() => false);
  if (!ok) {
    await registerFailure(ctx, cred);
    throw invalidCredentials();
  }
  if (user.status === 'BLOCKED' || user.deletedAt) throw new DomainError('ACCOUNT_BLOCKED', 'This account has been blocked');
  await AdminCredential.updateOne({ _id: cred._id }, { $set: { failedAttempts: 0 } });

  if (cred.totpEnabled) return { kind: 'mfa', mfaToken: await ctx.keys.signMfaToken(String(user._id)) };
  // Password-only session: short-lived, never refreshable (no cookie); only MFA enrolment accepts it.
  const session = await createSession(
    ctx,
    { userId: user._id, kind: 'ADMIN', amr: ['pwd'], refreshable: false, ttlMs: ctx.config.ACCESS_TOKEN_TTL_SEC * 1000 },
    meta,
  );
  return { kind: 'setup', user, session };
}

export async function mfaSetup(ctx: Ctx, userId: string): Promise<{ otpauthUri: string; secret: string }> {
  const { user, cred } = await loadAdmin(ctx, userId);
  if (cred.totpEnabled) throw new DomainError('CONFLICT', 'Two-factor authentication is already enabled');
  const secret = authenticator.generateSecret(20);
  await ctx.m.AdminCredential.updateOne(
    { _id: cred._id, totpEnabled: false },
    { $set: { totpSecretEnc: encryptField(secret, ctx.config.FIELD_ENCRYPTION_KEY), lastTotpStep: null } },
  );
  return { otpauthUri: authenticator.keyuri(user.email ?? String(user._id), ctx.config.TOTP_ISSUER, secret), secret };
}

export async function mfaEnable(ctx: Ctx, userId: string, code: string, meta: ClientMeta): Promise<void> {
  const { user, cred } = await loadAdmin(ctx, userId);
  assertNotLocked(cred);
  if (cred.totpEnabled) throw new DomainError('CONFLICT', 'Two-factor authentication is already enabled');
  if (!cred.totpSecretEnc) throw new DomainError('CONFLICT', 'Start two-factor setup first');
  const step = totpStep(decryptField(cred.totpSecretEnc, ctx.config.FIELD_ENCRYPTION_KEY), code);
  if (step === null) {
    await registerFailure(ctx, cred);
    throw new DomainError('INVALID_CREDENTIALS', 'Incorrect authenticator code');
  }
  await withTransaction(ctx.conn, async (session) => {
    const r = await ctx.m.AdminCredential.updateOne(
      { _id: cred._id, totpEnabled: false, totpSecretEnc: cred.totpSecretEnc },
      { $set: { totpEnabled: true, lastTotpStep: step, failedAttempts: 0 } },
      { session },
    );
    if (r.modifiedCount !== 1) throw new DomainError('CONFLICT', 'Two-factor setup changed; start again');
    await auditEvent(ctx.conn, session, {
      service: 'identity',
      actorId: String(user._id),
      actorRole: 'ADMIN',
      action: 'admin.mfa_enable',
      targetType: 'user',
      targetId: String(user._id),
      summary: `Enabled TOTP for ${user.email ?? String(user._id)}`,
      ...(meta.ip ? { ip: meta.ip } : {}),
    });
  });
}

export async function mfaVerify(
  ctx: Ctx,
  mfaToken: string,
  code: string,
  meta: ClientMeta,
): Promise<{ user: UserDoc; session: CreatedSession }> {
  const { userId } = await ctx.keys.verifyMfaToken(mfaToken);
  const { user, cred } = await loadAdmin(ctx, userId);
  assertNotLocked(cred);
  if (user.status === 'BLOCKED' || user.deletedAt) throw new DomainError('ACCOUNT_BLOCKED', 'This account has been blocked');
  if (!cred.totpEnabled || !cred.totpSecretEnc) throw new DomainError('CONFLICT', 'Two-factor authentication is not enabled');

  const step = totpStep(decryptField(cred.totpSecretEnc, ctx.config.FIELD_ENCRYPTION_KEY), code);
  if (step === null) {
    await registerFailure(ctx, cred);
    throw new DomainError('INVALID_CREDENTIALS', 'Incorrect authenticator code');
  }
  const accepted = await ctx.m.AdminCredential.updateOne(
    { _id: cred._id, totpEnabled: true, $or: [{ lastTotpStep: null }, { lastTotpStep: { $lt: step } }] },
    { $set: { lastTotpStep: step, failedAttempts: 0 } },
  );
  if (accepted.modifiedCount !== 1) {
    throw new DomainError('INVALID_CREDENTIALS', 'This code was already used. Wait for the next code.');
  }
  const session = await createSession(
    ctx,
    { userId: user._id, kind: 'ADMIN', amr: ['pwd', 'mfa'], ttlMs: ctx.config.ADMIN_SESSION_HOURS * 3_600_000 },
    meta,
  );
  return { user, session };
}
