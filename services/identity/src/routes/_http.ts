import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { DomainError } from '@thali/contracts';
import type { IdentityConfig } from '../config.js';
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH, type ClientMeta } from '../domain/sessions.js';

export const clientMeta = (req: Request): ClientMeta => ({
  ...(req.ip ? { ip: req.ip } : {}),
  ...(req.get('user-agent') ? { userAgent: req.get('user-agent')! } : {}),
});

function cookieBase(config: IdentityConfig): CookieOptions {
  return { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'strict', path: REFRESH_COOKIE_PATH };
}

export function setRefreshCookie(res: Response, config: IdentityConfig, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, { ...cookieBase(config), expires: expiresAt });
}

export function clearRefreshCookie(res: Response, config: IdentityConfig): void {
  res.clearCookie(REFRESH_COOKIE, cookieBase(config));
}

export function readRefreshCookie(req: Request): string | null {
  const v = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
  return typeof v === 'string' && v.length > 0 && v.length <= 512 ? v : null;
}

export const CSRF_HEADER_VALUE = 'thali-web';

/**
 * CSRF guard for the cookie-authenticated endpoints (refresh/logout, HLD §5): requires
 * `X-Requested-With: thali-web` AND an `Origin` header in the allow-list (browsers always send
 * Origin on POST; non-browser clients must send it explicitly).
 */
export function csrfGuard(config: IdentityConfig): RequestHandler {
  const allowed = new Set(config.CSRF_ALLOWED_ORIGINS);
  return (req, _res, next) => {
    if (req.get('x-requested-with') !== CSRF_HEADER_VALUE) {
      throw new DomainError('CSRF_CHECK_FAILED', 'Missing X-Requested-With header');
    }
    const origin = req.get('origin')?.replace(/\/+$/, '');
    if (!origin || !allowed.has(origin)) throw new DomainError('CSRF_CHECK_FAILED', 'Origin not allowed');
    next();
  };
}
