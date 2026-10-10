/**
 * Ed25519 test keys that mint identity-shaped access tokens, for testing `requireAuth` without the
 * identity service: `createApp({ auth: createAuthVerifier({ jwks: keys.jwks, redis }) })`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, exportPKCS8, exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type JSONWebKeySet, type JWK } from 'jose';
import type { AdminRole, Role } from '@thali/contracts';
import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER } from '../auth/jwks.js';

export interface TestTokenClaims {
  sub?: string;
  roles?: Role[];
  sid?: string;
  amr?: string[];
  adm?: AdminRole[];
  iss?: string;
  aud?: string;
  /** Seconds since epoch; default now. */
  iat?: number;
  /** Seconds since epoch; default iat + 900. */
  exp?: number;
  [claim: string]: unknown;
}

export interface TestKeys {
  kid: string;
  privateKey: CryptoKey;
  privateKeyPem: string;
  publicKeyPem: string;
  /** Public JWK with `kid`, `alg: 'EdDSA'`, `use: 'sig'`. */
  publicJwk: JWK;
  /** `{ keys: [publicJwk] }` — pass to `createAuthVerifier({ jwks })` or serve as a JWKS. */
  jwks: JSONWebKeySet;
  /**
   * Sign an access token. Defaults: random `sub` (24 hex), `roles: ['CONSUMER']`, random `sid`,
   * `amr: ['otp']`, `iss: 'thali-identity'`, `aud: 'thali'`, 15 min lifetime. Any claim can be overridden.
   */
  sign(claims?: TestTokenClaims): Promise<string>;
}

export async function generateTestKeys(): Promise<TestKeys> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const kid = `test-${randomBytes(4).toString('hex')}`;
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' };
  return {
    kid,
    privateKey,
    privateKeyPem: await exportPKCS8(privateKey),
    publicKeyPem: await exportSPKI(publicKey),
    publicJwk,
    jwks: { keys: [publicJwk] },
    async sign(claims = {}) {
      const iat = claims.iat ?? Math.floor(Date.now() / 1000);
      const payload = {
        sub: randomBytes(12).toString('hex'),
        roles: ['CONSUMER'],
        sid: randomUUID(),
        amr: ['otp'],
        iss: ACCESS_TOKEN_ISSUER,
        aud: ACCESS_TOKEN_AUDIENCE,
        exp: iat + 900,
        ...claims,
        iat,
      };
      return new SignJWT(payload).setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' }).sign(privateKey);
    },
  };
}
