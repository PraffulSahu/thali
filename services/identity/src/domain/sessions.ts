/**
 * Sessions & refresh rotation (HLD §5, LLD §5.2).
 *
 * - Refresh token: opaque 256-bit random (base64url), stored as SHA-256 (`refreshHash`).
 * - Rotate on every use. Presenting the immediately previous token within REFRESH_REUSE_GRACE_SEC
 *   (multi-tab race) returns an access token for the current state without rotating; presenting any
 *   older token (prev after grace, or one of `oldRefreshHashes`) is reuse → the whole session family is
 *   revoked (`revokedAt` + Redis `revoked:sid:<sid>`), 401 SESSION_REUSE_DETECTED.
 * - Revocation writes `<REDIS_KEY_PREFIX>revoked:sid:<sid>` via service-kit `revokeSession` with
 *   TTL = access-token lifetime, which every service's requireAuth checks.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import { DomainError } from '@thali/contracts';
import { revokeSession } from '@thali/service-kit';
import type { Ctx } from '../deps.js';
import { MAX_OLD_REFRESH_HASHES, type SessionDoc } from '../models/session.js';
import type { UserDoc } from '../models/user.js';

export const REFRESH_COOKIE = 'thali_rt';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export const hashToken = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');
export const newRefreshToken = () => randomBytes(32).toString('base64url');

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

export interface CreatedSession {
  sid: string;
  refreshToken: string | null;
  expiresAt: Date;
  amr: string[];
}

export async function createSession(
  ctx: Ctx,
  input: { userId: Types.ObjectId; kind: 'USER' | 'ADMIN'; amr: string[]; refreshable?: boolean; ttlMs: number },
  meta: ClientMeta,
  session?: ClientSession,
): Promise<CreatedSession> {
  const refreshable = input.refreshable ?? true;
  const raw = newRefreshToken();
  const expiresAt = new Date(Date.now() + input.ttlMs);
  const _id = new Types.ObjectId();
  await ctx.m.Session.create(
    [
      {
        _id,
        userId: input.userId,
        familyId: _id,
        kind: input.kind,
        refreshable,
        refreshHash: hashToken(raw),
        amr: input.amr,
        userAgent: meta.userAgent?.slice(0, 256),
        ip: meta.ip,
        expiresAt,
      },
    ],
    { session },
  );
  return { sid: String(_id), refreshToken: refreshable ? raw : null, expiresAt, amr: input.amr };
}

/** Access token for a user + session. Roles/adminRoles are read from the user (role grants apply on refresh). */
export function signAccessFor(ctx: Ctx, user: UserDoc, sid: string, amr: string[]): Promise<string> {
  return ctx.keys.signAccessToken({
    sub: String(user._id),
    roles: [...user.roles],
    adm: user.roles.includes('ADMIN') ? [...(user.adminRoles ?? [])] : undefined,
    sid,
    amr,
  });
}

export type RefreshOutcome =
  | { kind: 'rotated'; session: SessionDoc; user: UserDoc; refreshToken: string }
  | { kind: 'grace'; session: SessionDoc; user: UserDoc };

const unauthenticated = (msg = 'Session expired — sign in again') => new DomainError('UNAUTHENTICATED', msg);

export async function refreshSession(ctx: Ctx, raw: string): Promise<RefreshOutcome> {
  const { Session, User } = ctx.m;
  const h = hashToken(raw);
  let s = await Session.findOne({ $or: [{ refreshHash: h }, { prevRefreshHash: h }, { oldRefreshHashes: h }] }).lean<SessionDoc>();
  if (!s || !s.refreshable) throw unauthenticated();
  if (s.revokedAt) throw new DomainError('SESSION_REVOKED', 'Session has been revoked — sign in again');
  if (s.expiresAt.getTime() <= Date.now()) throw unauthenticated();

  const user = await User.findById(s.userId).lean<UserDoc>();
  if (!user || user.deletedAt) throw unauthenticated();
  if (user.status === 'BLOCKED') throw new DomainError('ACCOUNT_BLOCKED', 'This account has been blocked');

  if (s.refreshHash === h) {
    const next = newRefreshToken();
    const now = new Date();
    const updated = await Session.findOneAndUpdate(
      { _id: s._id, refreshHash: h, revokedAt: null },
      {
        $set: { refreshHash: hashToken(next), prevRefreshHash: h, rotatedAt: now },
        $push: { oldRefreshHashes: { $each: [h], $slice: -MAX_OLD_REFRESH_HASHES } },
      },
      { new: true },
    ).lean<SessionDoc>();
    if (updated) return { kind: 'rotated', session: updated, user, refreshToken: next };
    // Lost a concurrent rotation race: re-read and fall through to the grace/reuse rules.
    s = await Session.findById(s._id).lean<SessionDoc>();
    if (!s) throw unauthenticated();
    if (s.revokedAt) throw new DomainError('SESSION_REVOKED', 'Session has been revoked — sign in again');
  }

  const graceMs = ctx.config.REFRESH_REUSE_GRACE_SEC * 1000;
  if (s.prevRefreshHash === h && s.rotatedAt && Date.now() - s.rotatedAt.getTime() <= graceMs) {
    return { kind: 'grace', session: s, user };
  }

  await revokeSessionIds(ctx, [s._id], 'REUSE_DETECTED');
  ctx.logger.warn({ sid: String(s._id), userId: String(s.userId) }, 'refresh token reuse detected; session family revoked');
  throw new DomainError('SESSION_REUSE_DETECTED', 'Session ended for your security — sign in again');
}

/** Mark sessions revoked in Mongo, then write Redis revocation keys (TTL = access-token lifetime). */
export async function revokeSessionIds(ctx: Ctx, ids: Types.ObjectId[], reason: string): Promise<void> {
  if (!ids.length) return;
  await ctx.m.Session.updateMany({ _id: { $in: ids }, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
  await writeRevocations(ctx, ids.map(String));
}

export async function writeRevocations(ctx: Ctx, sids: string[]): Promise<void> {
  await Promise.all(sids.map((sid) => revokeSession(ctx.redis, sid, { ttlSec: ctx.config.ACCESS_TOKEN_TTL_SEC })));
}

/**
 * Revoke every live session of a user. With `session`, the Mongo update joins the caller's
 * transaction and the returned sids must be passed to `writeRevocations` AFTER commit.
 */
export async function revokeUserSessionsTx(
  ctx: Ctx,
  userId: Types.ObjectId,
  reason: string,
  session?: ClientSession,
): Promise<string[]> {
  const live = await ctx.m.Session.find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } }, { _id: 1 }, { session }).lean();
  const ids = live.map((s) => s._id);
  if (ids.length) {
    await ctx.m.Session.updateMany({ _id: { $in: ids }, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } }, { session });
  }
  return ids.map(String);
}

export async function revokeUserSessions(ctx: Ctx, userId: Types.ObjectId, reason: string): Promise<string[]> {
  const sids = await revokeUserSessionsTx(ctx, userId, reason);
  await writeRevocations(ctx, sids);
  return sids;
}

/** Revoke the session a refresh cookie belongs to (logout). Returns the sid or null. */
export async function revokeByRefreshToken(ctx: Ctx, raw: string): Promise<string | null> {
  const h = hashToken(raw);
  const s = await ctx.m.Session.findOne({ $or: [{ refreshHash: h }, { prevRefreshHash: h }] }, { _id: 1 }).lean();
  if (!s) return null;
  await revokeSessionIds(ctx, [s._id], 'LOGOUT');
  return String(s._id);
}
