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
 *   - audits `admin.password_reset_requested` in the same transaction;
 *   - asks notifications to email `${PUBLIC_WEB_URL}/admin/reset-password?token=<token>` (template
 *     ADMIN_PASSWORD_RESET, dedupeKey `admin-reset:<tokenId>`). A notifications failure is logged and
 *     recorded as a provider error (`identity` / `notifications`); the caller already got its 202.
 *
 * reset (`resetAdminPassword`): token (sha256 lookup, unexpired) → admin ACTIVE + not locked → valid,
 * unreplayed TOTP (a wrong code counts toward the login lockout) → password policy (≥ 12 chars, differs
 * from the current one) → in ONE transaction: consume the token (single use, guarded on the hash),
 * set the new argon2id hash, revoke every session of that admin, audit `admin.password_reset_completed`;
 * after commit the Redis revocation keys are written.
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
import { hashPassword, MIN_ADMIN_PASSWORD_LENGTH, registerFailure, totpStep } from './admin-auth.js';
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
      await auditEvent(ctx.conn, session, {
        service: 'identity',
        actorId: String(user._id),
        actorRole: 'ADMIN',
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

  const step = totpStep(decryptField(cred.totpSecretEnc, ctx.config.FIELD_ENCRYPTION_KEY), input.totpCode);
  if (step === null || (cred.lastTotpStep !== null && step <= cred.lastTotpStep)) {
    await registerFailure(ctx, cred); // counts toward the login lockout (throws 423 at the threshold)
    throw new DomainError('INVALID_CREDENTIALS', step === null ? 'Incorrect authenticator code' : 'This code was already used. Wait for the next code.');
  }

  if (input.newPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new DomainError('VALIDATION_FAILED', `Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`, undefined, { field: 'newPassword' });
  }
  if (await argon2.verify(cred.passwordHash, input.newPassword).catch(() => false)) {
    throw new DomainError('VALIDATION_FAILED', 'Choose a password you have not used for this account', undefined, { field: 'newPassword' });
  }
  const passwordHash = await hashPassword(input.newPassword);

  const sids = await withTransaction(ctx.conn, async (session) => {
    const r = await AdminCredential.updateOne(
      {
        _id: cred._id,
        resetTokenHash: tokenHash,
        resetExpiresAt: { $gt: new Date() },
        $or: [{ lastTotpStep: null }, { lastTotpStep: { $lt: step } }],
      },
      { $set: { passwordHash, resetTokenHash: null, resetExpiresAt: null, lastTotpStep: step, failedAttempts: 0 } },
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
      summary: `Password reset for ${user.email ?? String(user._id)}; ${revoked.length} session(s) revoked`,
      ...(meta.ip ? { ip: meta.ip } : {}),
    });
    return revoked;
  });
  await writeRevocations(ctx, sids);
}
