/** `GET /.well-known/jwks.json` — public Ed25519 key(s) for access-token verification (cached 5 min). */
import express, { type Router } from 'express';
import type { Ctx } from '../deps.js';

export function jwksRouter(ctx: Ctx): Router {
  const r = express.Router();
  r.get('/.well-known/jwks.json', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(ctx.keys.jwks());
  });
  return r;
}
