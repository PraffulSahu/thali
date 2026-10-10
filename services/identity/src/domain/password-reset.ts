/**
 * Admin forgot / reset password (IDN-1).
 *
 * forgot (`requestAdminPasswordReset`): the route answers 202 BEFORE this runs, so the response is the
 * same (status, body, timing) for unknown emails, non-admins, blocked/locked admins and real admins
 * (no account enumeration). For an eligible admin (ADMIN role, ACTIVE, not deleted, not locked, TOTP
 * enabled, has an email) it:
 *   - generates a token = 32 random bytes (base64url); only its SHA-256 is stored
 *     (`admin_credentials.resetTokenHash`, `resetExpiresAt` = now + 30 min). A new request replaces any
 *     earlier token (one outstanding token per admin);
 *   - audits `admin.password_reset_requested` in the same transaction (actor anonymous + IP, target admin);
 *   - asks notifications to email `${PUBLIC_WEB_URL}/admin/reset-password?token=<token>` (template
 *     ADMIN_PASSWORD_RESET, dedupeKey `admin-reset:<tokenId>`). A notifications failure is logged and
 *     recorded as a provider error (`identity` / `notifications`); the caller already got its 202.
 *
 * reset (`resetAdminPassword`): token (sha256 lookup, unexpired) → admin ACTIVE + not locked → valid,
 * unreplayed TOTP (a wrong code is audited `admin.password_reset_failed` and counts toward the login
 * lockout) → the TOTP step is consumed → password policy (≥ 12 chars, differs from the current one; one
 * generic error) → in ONE transaction: consume the token (single use, guarded on the hash), set the new
 * argon2id hash, bump `credentialVersion` + `passwordChangedAt` (pending mfaTokens die), revoke every
 * session of that admin, audit `admin.password_reset_completed`; after commit the Redis revocation keys
 * are written.
 */
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { Types } from 'mongoose';
import { DomainError } from '@thali/contracts';
import { auditEvent, decryptField, recordProviderError, withTransaction } from '@thali/service-kit';
import { webBaseUrl } from '../config.js';
import type { Ctx } from '../deps.js';
import { ADMIN_PASSWORD_RESET_TEMPLATE } from '../clients/notifications.js';
import type { AdminCredentialDoc } from '../models/admin-credential.js';
import type { UserDoc } from '../models/user.js';
import { hashPassword, registerFailure, totpStep } from './admin-auth.js';
import { MIN_ADMIN_PASSWORD_LENGTH } from './constants.js';
import { revokeUserSessionsTx, writeRevocations, type ClientMeta } from './sessions.js';

export const RESET_TOKEN_TTL_MINUTES = 30;

export const newResetToken = () => randomBytes(32).toString('base64url');
export const hashResetToken = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');

const isLocked = (cred: AdminCredentialDoc) => !!cred.lockedUntil && cred.lockedUntil.getTime() > Date.now();

/**
 * Issue + email a reset token if `email` belongs to an eligible admin; otherwise do nothing.
 * Never throws (runs after the 202 has been sent).
 */
export async function requestAdminPasswordReset(ctx: Ctx, rawEmail: string, meta: ClientMeta): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  try {
    const user = await ctx.m.User.findOne({ email, roles: 'ADMIN' }).lean<UserDoc>();
    const cred = user ? await ctx.m.AdminCredential.findOne({ userId: user._id }).lean<AdminCredentialDoc>() : null;
    const skip = !user
      ? 'unknown'
      : !cred
        ? 'no-credential'
        : user.status === 'BLOCKED' || user.deletedAt
          ? 'blocked'
          : isLocked(cred)
            ? 'locked'
            : !cred.totpEnabled || !cred.totpSecretEnc
              ? 'no-totp'
              : !user.email
                ? 'no-email'
                : null;
    if (skip || !user || !cred) {
      ctx.logger.info({ reason: skip }, 'admin password reset requested; no email sent');
      return;
    }

    const token = newResetToken();
    const tokenId = new Types.ObjectId().toHexString();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000);
    await withTransaction(ctx.conn, async (session) => {
      await ctx.m.AdminCredential.updateOne(
        { _id: cred._id },
        { $set: { resetTokenHash: hashResetToken(token), resetExpiresAt: expiresAt } },
        { session },
      );
      // Unauthenticated request: the actor is anonymous (with IP), the admin is only the subject.
      await auditEvent(ctx.conn, session, {
        service: 'identity',
        actorId: ANONYMOUS_ACTOR.actorId,
        actorRole: ANONYMOUS_ACTOR.actorRole,
        action: 'admin.password_reset_requested',
        targetType: 'user',
        targetId: String(user._id),
        summary: `Password reset link requested for ${user.email} (expires in ${RESET_TOKEN_TTL_MINUTES} min)`,
        ...(meta.ip ? { ip: meta.ip } : {}),
      });
    });

    const resetUrl = `${webBaseUrl(ctx.config)}/admin/reset-password?token=${token}`;
    try {
      await ctx.notifications.send({
        channel: 'EMAIL',
        to: user.email!,
        template: ADMIN_PASSWORD_RESET_TEMPLATE,
        data: { resetUrl, expiresMinutes: RESET_TOKEN_TTL_MINUTES },
        dedupeKey: `admin-reset:${tokenId}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'notifications send failed';
      ctx.logger.error({ userId: String(user._id), err: { message, code: (err as { code?: string }).code } }, 'admin password reset email could not be queued');
      await recordProviderError(ctx.redis, 'identity', 'notifications', Date.now(), message).catch(() => undefined);
    }
  } catch (err) {
    ctx.logger.error({ err }, 'admin password reset request failed');
  }
}

const invalidLink = () => new DomainError('INVALID_CREDENTIALS', 'This reset link is invalid or has expired. Request a new one.');
/** One message for every password-policy failure, so "same as current" is not distinguishable (no oracle). */
export const PASSWORD_POLICY_MESSAGE = `Password does not meet the admin password policy (at least ${MIN_ADMIN_PASSWORD_LENGTH} characters, different from the current password)`;
const policyError = () => new DomainError('VALIDATION_FAILED', PASSWORD_POLICY_MESSAGE, undefined, { field: 'newPassword' });

export async function resetAdminPassword(
  ctx: Ctx,
  input: { token: string; newPassword: string; totpCode: string },
  meta: ClientMeta,
): Promise<void> {
  const { AdminCredential, User } = ctx.m;
  const tokenHash = hashResetToken(input.token);
  const cred = await AdminCredential.findOne({ resetTokenHash: tokenHash, resetExpiresAt: { $gt: new Date() } }).lean<AdminCredentialDoc>();
  if (!cred) throw invalidLink();
  const user = await User.findById(cred.userId).lean<UserDoc>();
  if (!user || !user.roles.includes('ADMIN')) throw invalidLink();
  if (user.status === 'BLOCKED' || user.deletedAt) throw new DomainError('ACCOUNT_BLOCKED', 'This account has been blocked');
  if (isLocked(cred)) {
    throw new DomainError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', undefined, { lockedUntil: cred.lockedUntil!.toISOString() });
  }
  if (!cred.totpEnabled || !cred.totpSecretEnc) throw invalidLink();

  // 1. TOTP: valid and newer than the last accepted step. A failure with a valid link is audited
  //    (strong sign the mailbox is compromised) and counts toward the login lockout.
  const step = totpStep(decryptField(cred.totpSecretEnc, ctx.config.FIELD_ENCRYPTION_KEY), input.totpCode);
  const replay = step !== null && cred.lastTotpStep !== null && step <= cred.lastTotpStep;
  if (step === null || replay) {
    await auditResetFailure(ctx, user, replay ? 'reused authenticator code' : 'wrong authenticator code', meta);
    await registerFailure(ctx, cred); // throws 423 at the threshold
    throw new DomainError('INVALID_CREDENTIALS', replay ? 'This code was already used. Wait for the next code.' : 'Incorrect authenticator code');
  }

  // 2. Consume the TOTP step BEFORE any password check: each policy probe costs a fresh code.
  const consumed = await AdminCredential.updateOne(
    { _id: cred._id, resetTokenHash: tokenHash, resetExpiresAt: { $gt: new Date() }, $or: [{ lastTotpStep: null }, { lastTotpStep: { $lt: step } }] },
    { $set: { lastTotpStep: step, failedAttempts: 0 } },
  );
  if (consumed.modifiedCount !== 1) {
    const still = await AdminCredential.exists({ _id: cred._id, resetTokenHash: tokenHash, resetExpiresAt: { $gt: new Date() } });
    if (!still) throw invalidLink();
    throw new DomainError('INVALID_CREDENTIALS', 'This code was already used. Wait for the next code.');
  }

  // 3. Policy (generic error for every rule; the token stays valid for another try with a new code).
  if (input.newPassword.length < MIN_ADMIN_PASSWORD_LENGTH) throw policyError();
  if (await argon2.verify(cred.passwordHash, input.newPassword).catch(() => false)) throw policyError();
  const passwordHash = await hashPassword(input.newPassword);

  // 4. Consume the token, bump the credential version (kills pending mfaTokens), revoke sessions, audit.
  const sids = await withTransaction(ctx.conn, async (session) => {
    const r = await AdminCredential.updateOne(
      { _id: cred._id, resetTokenHash: tokenHash, resetExpiresAt: { $gt: new Date() } },
      {
        $set: { passwordHash, resetTokenHash: null, resetExpiresAt: null, failedAttempts: 0, passwordChangedAt: new Date() },
        $inc: { credentialVersion: 1 },
      },
      { session },
    );
    if (r.modifiedCount !== 1) throw invalidLink(); // used concurrently / replaced / expired meanwhile
    const revoked = await revokeUserSessionsTx(ctx, user._id, 'PASSWORD_RESET', session);
    await auditEvent(ctx.conn, session, {
      service: 'identity',
      actorId: String(user._id),
      actorRole: 'ADMIN',
      action: 'admin.password_reset_completed',
      targetType: 'user',
      targetId: String(user._id),
      summary: `Password reset for ${user.email ?? String(user._id)} (link + authenticator code); ${revoked.length} session(s) revoked`,
      ...(meta.ip ? { ip: meta.ip } : {}),
    });
    return revoked;
  });
  await writeRevocations(ctx, sids);
}

/** Actor for unauthenticated password-reset events (the admin is the target, not the actor). */
export const ANONYMOUS_ACTOR = { actorId: 'anonymous', actorRole: 'ANONYMOUS' } as const;

async function auditResetFailure(ctx: Ctx, user: UserDoc, reason: string, meta: ClientMeta): Promise<void> {
  try {
    await withTransaction(ctx.conn, (session) =>
      auditEvent(ctx.conn, session, {
        service: 'identity',
        ...ANONYMOUS_ACTOR,
        action: 'admin.password_reset_failed',
        targetType: 'user',
        targetId: String(user._id),
        summary: `Password reset with a valid link failed for ${user.email ?? String(user._id)}: ${reason}`,
        ...(meta.ip ? { ip: meta.ip } : {}),
      }),
    );
  } catch (err) {
    ctx.logger.error({ err, userId: String(user._id) }, 'could not audit failed password reset');
  }
}
