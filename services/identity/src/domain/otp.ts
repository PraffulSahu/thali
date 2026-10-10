/**
 * Phone OTP (LLD §5.1).
 *
 * request: per-phone cooldown (OTP_RESEND_COOLDOWN_SEC) + per-phone hourly cap (OTP_MAX_PER_HOUR) via
 * service-kit `consumeRateLimit` on the *normalized* phone (the per-IP cap is route middleware). A
 * pending challenge (sentAt=null) is stored first, the code is sent via notifications, and only then
 * is it marked sent and older challenges invalidated. If delivery fails → 503 OTP_DELIVERY_FAILED,
 * the pending challenge is invalidated and the rate-limit hits are refunded (not counted as sent).
 *
 * verify: latest live challenge → expiry → atomic `attempts++` guarded by `attempts < maxAttempts` →
 * constant-time HMAC compare → in ONE transaction: consume (`consumedAt: null` guard; single use),
 * find-or-create user (+ `user.registered` outbox event), create session.
 *
 * Demo: APP_MODE=demo + DEMO_OTP_ENABLED + phone ∈ DEMO_PHONES → code 123456, challenge still created,
 * nothing sent, `demoOtp: true`. A demo challenge is re-checked against the config at verify time.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { Types } from 'mongoose';
import { DomainError } from '@thali/contracts';
import { consumeRateLimit, emitEvent, redisKey, withTransaction } from '@thali/service-kit';
import { demoOtpAllowed } from '../config.js';
import type { Ctx } from '../deps.js';
import type { OtpChallengeDoc } from '../models/otp-challenge.js';
import type { UserDoc } from '../models/user.js';
import { createSession, type ClientMeta, type CreatedSession } from './sessions.js';

export const DEMO_OTP_CODE = '123456';

export function hashOtp(pepper: string, phone: string, code: string): string {
  return createHmac('sha256', pepper).update(`${phone}:${code}`, 'utf8').digest('hex');
}

export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

const cooldownKey = (phone: string) => `otp-cooldown:${phone}`;
const hourlyKey = (phone: string) => `otp-hour:${phone}`;

async function limit(ctx: Ctx, key: string, points: number, durationSec: number, message: string): Promise<void> {
  let r;
  try {
    r = await consumeRateLimit({ redis: ctx.redis, key, points, durationSec });
  } catch (err) {
    ctx.logger.error({ err }, 'OTP rate limiter unavailable; failing closed');
    throw new DomainError('SERVICE_UNAVAILABLE', 'Rate limiter unavailable');
  }
  if (!r.allowed) throw new DomainError('RATE_LIMITED', message, undefined, { retryAfterSec: r.retryAfterSec });
}

/** Undo this request's rate-limit hits after a failed delivery (best-effort). */
async function refundLimits(ctx: Ctx, phone: string): Promise<void> {
  try {
    await ctx.redis.del(redisKey(ctx.redis, `rl:${cooldownKey(phone)}`));
    await ctx.redis.decr(redisKey(ctx.redis, `rl:${hourlyKey(phone)}`));
  } catch (err) {
    ctx.logger.warn({ err }, 'could not refund OTP rate-limit counters');
  }
}

export interface OtpRequestResult {
  status: 'SENT';
  expiresAt: string;
  resendAfterSec: number;
  demoOtp?: true;
}

export async function requestOtp(ctx: Ctx, phone: string, meta: ClientMeta): Promise<OtpRequestResult> {
  const { config } = ctx;
  const { OtpChallenge } = ctx.m;
  if (config.OTP_RESEND_COOLDOWN_SEC > 0) {
    await limit(ctx, cooldownKey(phone), 1, config.OTP_RESEND_COOLDOWN_SEC, 'Please wait before requesting another code');
  }
  await limit(ctx, hourlyKey(phone), config.OTP_MAX_PER_HOUR, 3600, 'Too many codes requested for this number. Try again later.');

  const demo = demoOtpAllowed(config, phone);
  const code = demo ? DEMO_OTP_CODE : generateOtp();
  const expiresAt = new Date(Date.now() + config.OTP_TTL_SEC * 1000);
  const pending = await OtpChallenge.create({
    phone,
    codeHash: hashOtp(config.OTP_PEPPER, phone, code),
    purpose: 'LOGIN',
    expiresAt,
    maxAttempts: config.OTP_MAX_ATTEMPTS,
    demo,
    ip: meta.ip,
  });

  if (!demo) {
    try {
      await ctx.notifications.sendOtp(phone, code);
    } catch (err) {
      await OtpChallenge.updateOne({ _id: pending._id }, { $set: { invalidatedAt: new Date() } }).catch(() => undefined);
      await refundLimits(ctx, phone);
      if (err instanceof DomainError && err.code === 'OTP_DELIVERY_FAILED') throw err;
      ctx.logger.error({ err }, 'OTP delivery failed');
      throw new DomainError('OTP_DELIVERY_FAILED', 'Could not send the verification code. Please try again.');
    }
  }

  const now = new Date();
  await withTransaction(ctx.conn, async (session) => {
    await OtpChallenge.updateMany(
      { phone, _id: { $ne: pending._id }, consumedAt: null, invalidatedAt: null },
      { $set: { invalidatedAt: now } },
      { session },
    );
    await OtpChallenge.updateOne(
      { _id: pending._id },
      demo ? { $set: { lastSentAt: null } } : { $set: { sentAt: now, lastSentAt: now }, $inc: { sendCount: 1 } },
      { session },
    );
  });

  return {
    status: 'SENT',
    expiresAt: expiresAt.toISOString(),
    resendAfterSec: config.OTP_RESEND_COOLDOWN_SEC,
    ...(demo ? { demoOtp: true as const } : {}),
  };
}

export interface OtpLoginResult {
  user: UserDoc;
  session: CreatedSession;
  isNew: boolean;
  demo: boolean;
}

export async function verifyOtp(ctx: Ctx, phone: string, code: string, meta: ClientMeta): Promise<OtpLoginResult> {
  const { config } = ctx;
  const { OtpChallenge, User } = ctx.m;
  const invalid = () => new DomainError('OTP_INVALID', 'Incorrect code. Please check and try again.');

  const ch = await OtpChallenge.findOne({
    phone,
    consumedAt: null,
    invalidatedAt: null,
    $or: [{ sentAt: { $ne: null } }, { demo: true }],
  })
    .sort({ createdAt: -1, _id: -1 })
    .lean<OtpChallengeDoc>();
  if (!ch) throw invalid();
  if (ch.expiresAt.getTime() <= Date.now()) throw new DomainError('OTP_EXPIRED', 'This code has expired. Request a new one.');
  if (ch.demo && !demoOtpAllowed(config, phone)) throw invalid();

  const counted = await OtpChallenge.findOneAndUpdate(
    { _id: ch._id, consumedAt: null, invalidatedAt: null, $expr: { $lt: ['$attempts', '$maxAttempts'] } },
    { $inc: { attempts: 1 } },
    { new: true },
  ).lean<OtpChallengeDoc>();
  if (!counted) {
    const cur = await OtpChallenge.findById(ch._id).lean<OtpChallengeDoc>();
    if (cur && !cur.consumedAt && !cur.invalidatedAt && cur.attempts >= cur.maxAttempts) {
      throw new DomainError('OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts. Request a new code.');
    }
    throw invalid();
  }
  if (!safeEqualHex(hashOtp(config.OTP_PEPPER, phone, code), ch.codeHash)) throw invalid();

  return withTransaction(ctx.conn, async (session) => {
    const consumed = await OtpChallenge.updateOne({ _id: ch._id, consumedAt: null }, { $set: { consumedAt: new Date() } }, { session });
    if (consumed.modifiedCount !== 1) throw invalid();

    let user = await User.findOne({ phone }, null, { session }).lean<UserDoc>();
    let isNew = false;
    if (!user) {
      const [created] = await User.create([{ phone, roles: ['CONSUMER'] }], { session });
      user = created!.toObject() as UserDoc;
      isNew = true;
      await emitEvent(
        ctx.conn,
        session,
        'user.registered',
        { userId: String(user._id), phone },
        { producer: 'identity', aggregateId: String(user._id) },
      );
    }
    if (user.status === 'BLOCKED' || user.deletedAt) throw new DomainError('ACCOUNT_BLOCKED', 'This account has been blocked');

    const s = await createSession(
      ctx,
      { userId: user._id as Types.ObjectId, kind: 'USER', amr: ['otp'], ttlMs: config.SESSION_DAYS * 86_400_000 },
      meta,
      session,
    );
    return { user, session: s, isNew, demo: ch.demo };
  });
}
