/**
 * Business-email verification (LLD 4.6, brief): 32-byte base64url token, only its sha256 stored,
 * 24 h expiry, 60 s resend cooldown. The verify link hits the gateway
 * `${PUBLIC_API_URL}/api/v1/restaurants/verify-email?token=...`, which redirects to
 * `${PUBLIC_WEB_URL}/restaurant/onboarding?emailVerified=1|0&reason=`.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { DomainError } from '@thali/contracts';
import { withTransaction } from '@thali/service-kit';
import type { AppContext } from '../context.js';
import { emitEmailVerificationRequested } from '../events/restaurant-events.js';
import type { RestaurantHydrated } from './restaurant-view.js';
import { transitionRestaurant } from './transitions.js';

export const EMAIL_TOKEN_BYTES = 32;
export const EMAIL_TOKEN_TTL_MS = 24 * 3600_000;
export const EMAIL_RESEND_COOLDOWN_SEC = 60;
/** Max verification emails per restaurant per rolling 24 h window (submit, resend and email changes). */
export const EMAIL_MAX_PER_DAY = 5;
const DAY_MS = 24 * 3600_000;

export const hashToken = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');

export function verifyUrl(publicApiUrl: string, raw: string): string {
  return `${publicApiUrl.replace(/\/+$/, '')}/api/v1/restaurants/verify-email?token=${raw}`;
}

/**
 * Issue a fresh token on `doc` (replacing any previous one) and enqueue the email event.
 * Every send path (submit, resend, businessEmail change) goes through here, so the 60 s cooldown and
 * the per-restaurant daily cap apply to all of them → 429 RATE_LIMITED (aborts the caller's txn).
 * Must run inside the caller's transaction; the caller saves `doc`.
 */
export async function issueVerification(ctx: AppContext, session: ClientSession, doc: RestaurantHydrated): Promise<void> {
  if (!doc.businessEmail) throw new DomainError('VALIDATION_FAILED', 'businessEmail is required', undefined, { missing: ['businessEmail'] });
  const now = ctx.now();
  const log = doc.emailVerificationLog;
  if (log?.lastSentAt) {
    const elapsedSec = (now.getTime() - log.lastSentAt.getTime()) / 1000;
    if (elapsedSec < EMAIL_RESEND_COOLDOWN_SEC) {
      const retryAfterSec = Math.ceil(EMAIL_RESEND_COOLDOWN_SEC - elapsedSec);
      throw new DomainError('RATE_LIMITED', `Please wait ${retryAfterSec}s before sending another verification email`, undefined, { retryAfterSec });
    }
  }
  const inWindow = !!log?.windowStart && now.getTime() - log.windowStart.getTime() < DAY_MS;
  const count = inWindow ? log!.count : 0;
  if (count >= EMAIL_MAX_PER_DAY) {
    const retryAfterSec = Math.ceil((log!.windowStart.getTime() + DAY_MS - now.getTime()) / 1000);
    throw new DomainError('RATE_LIMITED', `Verification email limit reached (${EMAIL_MAX_PER_DAY} per 24 h)`, undefined, { retryAfterSec });
  }
  doc.set('emailVerificationLog', { windowStart: inWindow ? log!.windowStart : now, count: count + 1, lastSentAt: now });

  const raw = randomBytes(EMAIL_TOKEN_BYTES).toString('base64url');
  doc.set('emailVerification', { tokenHash: hashToken(raw), expiresAt: new Date(now.getTime() + EMAIL_TOKEN_TTL_MS), sentAt: now });
  await emitEmailVerificationRequested(ctx.conn, session, doc, doc.businessEmail, verifyUrl(ctx.config.PUBLIC_API_URL, raw));
}

export type VerifyOutcome = { emailVerified: true; reason?: 'already_verified' } | { emailVerified: false; reason: 'invalid' | 'expired' };

/** Consume a token. Reuse is a no-op; expired leaves status unchanged. */
export async function verifyEmailToken(ctx: AppContext, raw: string | undefined): Promise<VerifyOutcome> {
  if (!raw || !/^[A-Za-z0-9_-]{20,100}$/.test(raw)) return { emailVerified: false, reason: 'invalid' };
  const tokenHash = hashToken(raw);
  return withTransaction(ctx.conn, async (session): Promise<VerifyOutcome> => {
    const doc = await ctx.models.Restaurant.findOne({ 'emailVerification.tokenHash': tokenHash }).session(session);
    if (!doc || !doc.emailVerification) return { emailVerified: false, reason: 'invalid' };
    if (doc.emailVerification.usedAt) return { emailVerified: true, reason: 'already_verified' };
    const now = ctx.now();
    if (doc.emailVerification.expiresAt.getTime() <= now.getTime()) return { emailVerified: false, reason: 'expired' };

    doc.set('emailVerification.usedAt', now);
    doc.emailVerifiedAt = now;
    if (doc.status === 'VERIFICATION_PENDING') {
      await transitionRestaurant(ctx, session, doc, 'APPROVAL_PENDING', { actor: 'SYSTEM', actorId: 'system:email-verification' });
    }
    await doc.save({ session });
    return { emailVerified: true };
  });
}

export function redirectUrl(publicWebUrl: string, outcome: VerifyOutcome): string {
  const q = new URLSearchParams({ emailVerified: outcome.emailVerified ? '1' : '0' });
  if (outcome.reason) q.set('reason', outcome.reason);
  return `${publicWebUrl.replace(/\/+$/, '')}/restaurant/onboarding?${q.toString()}`;
}

/** Owner "resend": only while the current email is unverified and a verification is in flight. */
export async function resendVerification(ctx: AppContext, restaurantId: string, ownerUserId: string) {
  return withTransaction(ctx.conn, async (session) => {
    const doc = await ctx.models.Restaurant.findOne({ _id: restaurantId, ownerUserId }).session(session);
    if (!doc) throw new DomainError('NOT_FOUND', 'Restaurant not found');
    if (doc.status === 'DRAFT' || doc.emailVerifiedAt || !doc.emailVerification) {
      throw new DomainError('CONFLICT', 'There is no pending email verification for this restaurant');
    }
    await issueVerification(ctx, session, doc);
    await doc.save({ session });
    return { sentAt: doc.emailVerification!.sentAt.toISOString(), expiresAt: doc.emailVerification!.expiresAt.toISOString() };
  });
}
