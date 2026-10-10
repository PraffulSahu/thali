/** `/api/v1/auth/admin` — admin password + TOTP (LLD §5.3). There is deliberately no registration route. */
import express, { type Router } from 'express';
import { DomainError } from '@thali/contracts';
import { rateLimit, requireAuth, validate } from '@thali/service-kit';
import type { Ctx } from '../deps.js';
import { adminLogin, mfaEnable, mfaSetup, mfaVerify } from '../domain/admin-auth.js';
import { signAccessFor } from '../domain/sessions.js';
import { MFA_TOKEN_TTL_SEC } from '../domain/tokens.js';
import { toUserView } from '../domain/views.js';
import { AdminLoginBody, AdminMfaBody, MfaEnableBody } from '../schemas.js';
import { clientMeta, setRefreshCookie } from './_http.js';

export function adminAuthRouter(ctx: Ctx): Router {
  const { config, redis } = ctx;
  const r = express.Router();

  // LLD §5.4: admin login 10 / 15 min per IP+email — fails CLOSED if Redis is down.
  const loginLimit = rateLimit({
    redis,
    name: 'admin-login',
    keyFn: (req) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      return `${req.ip}:${typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : ''}`;
    },
    points: config.ADMIN_LOGIN_MAX_PER_WINDOW,
    durationSec: config.ADMIN_LOGIN_WINDOW_SEC,
    message: 'Too many sign-in attempts. Try again later.',
  });
  const mfaLimit = rateLimit({
    redis,
    name: 'admin-mfa',
    keyFn: (req) => req.ip,
    points: config.ADMIN_LOGIN_MAX_PER_WINDOW * 3,
    durationSec: config.ADMIN_LOGIN_WINDOW_SEC,
  });
  const pwdAdmin = requireAuth({ roles: ['ADMIN'] });
  const needPwd: express.RequestHandler = (req, _res, next) => {
    if (!req.auth!.amr.includes('pwd')) throw new DomainError('FORBIDDEN', 'Admin password session required');
    next();
  };

  const vLogin = validate({ body: AdminLoginBody });
  r.post('/login', loginLimit, vLogin, async (req, res) => {
    const { body } = vLogin.get(req);
    const result = await adminLogin(ctx, body.email, body.password, clientMeta(req));
    if (result.kind === 'mfa') {
      res.json({ mfaRequired: true, mfaToken: result.mfaToken, expiresInSec: MFA_TOKEN_TTL_SEC });
      return;
    }
    res.json({
      mfaSetupRequired: true,
      accessToken: await signAccessFor(ctx, result.user, result.session.sid, result.session.amr),
      tokenType: 'Bearer',
      expiresInSec: ctx.keys.accessTtlSec,
      user: toUserView(result.user),
    });
  });

  const vMfa = validate({ body: AdminMfaBody });
  r.post('/mfa', mfaLimit, vMfa, async (req, res) => {
    const { body } = vMfa.get(req);
    const { user, session } = await mfaVerify(ctx, body.mfaToken, body.code, clientMeta(req));
    setRefreshCookie(res, config, session.refreshToken!, session.expiresAt);
    res.json({
      accessToken: await signAccessFor(ctx, user, session.sid, session.amr),
      tokenType: 'Bearer',
      expiresInSec: ctx.keys.accessTtlSec,
      user: toUserView(user),
    });
  });

  r.post('/mfa/setup', pwdAdmin, needPwd, async (req, res) => {
    res.json(await mfaSetup(ctx, req.auth!.userId));
  });

  const vEnable = validate({ body: MfaEnableBody });
  r.post('/mfa/enable', mfaLimit, pwdAdmin, needPwd, vEnable, async (req, res) => {
    const { body } = vEnable.get(req);
    await mfaEnable(ctx, req.auth!.userId, body.code, clientMeta(req));
    res.json({ enabled: true });
  });

  return r;
}
