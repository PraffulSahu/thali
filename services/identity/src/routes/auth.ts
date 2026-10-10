/** `/api/v1/auth` — phone OTP, refresh rotation, logout (LLD §5.1, §5.2, §10). */
import express, { type Router } from 'express';
import { DomainError } from '@thali/contracts';
import { rateLimit, requireAuth, validate } from '@thali/service-kit';
import type { Ctx } from '../deps.js';
import { requestOtp, verifyOtp } from '../domain/otp.js';
import { refreshSession, revokeByRefreshToken, revokeUserSessions, signAccessFor } from '../domain/sessions.js';
import { toUserView, oid } from '../domain/views.js';
import { OtpRequestBody, OtpVerifyBody } from '../schemas.js';
import { clearRefreshCookie, clientMeta, csrfGuard, readRefreshCookie, setRefreshCookie } from './_http.js';

export function authRouter(ctx: Ctx): Router {
  const { config, redis } = ctx;
  const r = express.Router();
  const csrf = csrfGuard(config);

  // Per-IP limits fail CLOSED (service-kit default) — security limits.
  const otpIpLimit = rateLimit({
    redis,
    name: 'otp-ip',
    keyFn: (req) => req.ip,
    points: config.OTP_MAX_PER_IP_PER_HOUR,
    durationSec: 3600,
    message: 'Too many verification codes requested from this network. Try again later.',
  });
  const verifyIpLimit = rateLimit({
    redis,
    name: 'otp-verify-ip',
    keyFn: (req) => req.ip,
    points: config.OTP_MAX_PER_IP_PER_HOUR * 5,
    durationSec: 3600,
  });

  const vRequest = validate({ body: OtpRequestBody });
  r.post('/otp/request', otpIpLimit, vRequest, async (req, res) => {
    const { body } = vRequest.get(req);
    res.json(await requestOtp(ctx, body.phone, clientMeta(req)));
  });

  const vVerify = validate({ body: OtpVerifyBody });
  r.post('/otp/verify', verifyIpLimit, vVerify, async (req, res) => {
    const { body } = vVerify.get(req);
    const result = await verifyOtp(ctx, body.phone, body.code, clientMeta(req));
    const accessToken = await signAccessFor(ctx, result.user, result.session.sid, result.session.amr);
    let guestCartMerged: boolean | undefined;
    if (body.guestCartToken) {
      try {
        await ctx.orders.mergeCart(String(result.user._id), body.guestCartToken);
        guestCartMerged = true;
      } catch (err) {
        req.log.warn({ err }, 'guest cart merge failed (best-effort; client retries via /cart/merge)');
        guestCartMerged = false;
      }
    }
    setRefreshCookie(res, config, result.session.refreshToken!, result.session.expiresAt);
    res.json({
      accessToken,
      tokenType: 'Bearer',
      expiresInSec: ctx.keys.accessTtlSec,
      user: toUserView(result.user),
      ...(guestCartMerged !== undefined ? { guestCartMerged } : {}),
      ...(result.demo ? { demoOtp: true } : {}),
    });
  });

  r.post('/refresh', csrf, async (req, res) => {
    const raw = readRefreshCookie(req);
    if (!raw) throw new DomainError('UNAUTHENTICATED', 'Session expired — sign in again');
    let outcome;
    try {
      outcome = await refreshSession(ctx, raw);
    } catch (err) {
      if (err instanceof DomainError && ['UNAUTHENTICATED', 'SESSION_REVOKED', 'SESSION_REUSE_DETECTED', 'ACCOUNT_BLOCKED'].includes(err.code)) {
        clearRefreshCookie(res, config);
      }
      throw err;
    }
    const sid = String(outcome.session._id);
    const accessToken = await signAccessFor(ctx, outcome.user, sid, outcome.session.amr);
    if (outcome.kind === 'rotated') setRefreshCookie(res, config, outcome.refreshToken, outcome.session.expiresAt);
    res.json({ accessToken, tokenType: 'Bearer', expiresInSec: ctx.keys.accessTtlSec, user: toUserView(outcome.user) });
  });

  r.post('/logout', csrf, async (req, res) => {
    const raw = readRefreshCookie(req);
    if (raw) await revokeByRefreshToken(ctx, raw);
    clearRefreshCookie(res, config);
    res.status(204).end();
  });

  r.post('/logout-all', requireAuth(), async (req, res) => {
    const userId = oid(req.auth!.userId);
    if (userId) await revokeUserSessions(ctx, userId, 'LOGOUT_ALL');
    clearRefreshCookie(res, config);
    res.status(204).end();
  });

  return r;
}
