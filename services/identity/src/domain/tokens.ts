/**
 * Access-token signing (HLD §5): EdDSA/Ed25519, 15 min, claims `{sub, roles, adm?, sid, amr}` with
 * `iss`/`aud` pinned to service-kit's `ACCESS_TOKEN_ISSUER`/`ACCESS_TOKEN_AUDIENCE` so every service's
 * `createAuthVerifier` accepts them. Also the 5-minute admin MFA step token (aud `mfa`, never
 * accepted as an access token).
 *
 * Key source: `JWT_PRIVATE_KEY_PEM` (required in production) or, in demo/sandbox, an Ed25519 key
 * generated once and persisted (encrypted) in `signing_keys`.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, jwtVerify, SignJWT, type JSONWebKeySet, type JWK } from 'jose';
import type { Connection } from 'mongoose';
import { DomainError, type AdminRole, type Role } from '@thali/contracts';
import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER, ConfigError, decryptField, encryptField } from '@thali/service-kit';
import type { IdentityConfig } from '../config.js';
import { SigningKeyModel } from '../models/signing-key.js';

export const MFA_TOKEN_AUDIENCE = 'mfa';
export const MFA_TOKEN_TTL_SEC = 300;

export interface AccessClaims {
  sub: string;
  roles: Role[];
  adm?: AdminRole[];
  sid: string;
  amr: string[];
}

export interface KeyStore {
  readonly kid: string;
  readonly accessTtlSec: number;
  /** Public JWKS (`kid`, `alg: EdDSA`, `use: sig`) for `/.well-known/jwks.json`. */
  jwks(): JSONWebKeySet;
  signAccessToken(claims: AccessClaims): Promise<string>;
  /** `credentialVersion` (claim `cv`) binds the token to the admin's current password. */
  signMfaToken(userId: string, credentialVersion?: number): Promise<string>;
  /** → `{ userId, credentialVersion }` (missing `cv` = 0) or 401 UNAUTHENTICATED. */
  verifyMfaToken(token: string): Promise<{ userId: string; credentialVersion: number }>;
}

function publicJwkOf(publicKey: KeyObject, kid: string): JWK {
  const jwk = publicKey.export({ format: 'jwk' }) as JWK;
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid, alg: 'EdDSA', use: 'sig' };
}

export function createKeyStore(privateKey: KeyObject, kid: string, accessTtlSec = 900): KeyStore {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new ConfigError(['JWT_PRIVATE_KEY_PEM: must be an Ed25519 key']);
  const publicKey = createPublicKey(privateKey);
  const jwk = publicJwkOf(publicKey, kid);
  return {
    kid,
    accessTtlSec,
    jwks: () => ({ keys: [{ ...jwk }] }),
    async signAccessToken(c) {
      const now = Math.floor(Date.now() / 1000);
      const payload: Record<string, unknown> = { roles: c.roles, sid: c.sid, amr: c.amr };
      if (c.adm?.length) payload.adm = c.adm;
      return new SignJWT(payload)
        .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
        .setSubject(c.sub)
        .setIssuer(ACCESS_TOKEN_ISSUER)
        .setAudience(ACCESS_TOKEN_AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(now + accessTtlSec)
        .sign(privateKey);
    },
    async signMfaToken(userId, credentialVersion = 0) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ typ: 'mfa', cv: credentialVersion })
        .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
        .setSubject(userId)
        .setIssuer(ACCESS_TOKEN_ISSUER)
        .setAudience(MFA_TOKEN_AUDIENCE)
        .setJti(randomUUID())
        .setIssuedAt(now)
        .setExpirationTime(now + MFA_TOKEN_TTL_SEC)
        .sign(privateKey);
    },
    async verifyMfaToken(token) {
      try {
        const { payload } = await jwtVerify(token, publicKey, {
          algorithms: ['EdDSA'],
          issuer: ACCESS_TOKEN_ISSUER,
          audience: MFA_TOKEN_AUDIENCE,
        });
        if (payload.typ !== 'mfa' || typeof payload.sub !== 'string') throw new Error('bad mfa token');
        const cv = payload.cv === undefined ? 0 : payload.cv;
        if (typeof cv !== 'number' || !Number.isInteger(cv)) throw new Error('bad mfa token');
        return { userId: payload.sub, credentialVersion: cv };
      } catch {
        throw new DomainError('UNAUTHENTICATED', 'MFA session expired — sign in again');
      }
    },
  };
}

/** Load the signing key per config: env PEM, else (non-production) the persisted/generated DB key. */
export async function loadSigningKeys(conn: Connection, config: IdentityConfig): Promise<KeyStore> {
  const ttl = config.ACCESS_TOKEN_TTL_SEC;
  if (config.JWT_PRIVATE_KEY_PEM) {
    let priv: KeyObject;
    try {
      priv = createPrivateKey(config.JWT_PRIVATE_KEY_PEM.replace(/\\n/g, '\n'));
    } catch {
      throw new ConfigError(['JWT_PRIVATE_KEY_PEM: not a valid PKCS#8 PEM']);
    }
    if (priv.asymmetricKeyType !== 'ed25519') throw new ConfigError(['JWT_PRIVATE_KEY_PEM: must be an Ed25519 key']);
    const derived = createPublicKey(priv).export({ format: 'jwk' }) as JWK;
    if (config.JWT_PUBLIC_KEY_PEM) {
      const given = createPublicKey(config.JWT_PUBLIC_KEY_PEM.replace(/\\n/g, '\n')).export({ format: 'jwk' }) as JWK;
      if (given.x !== derived.x) throw new ConfigError(['JWT_PUBLIC_KEY_PEM: does not match JWT_PRIVATE_KEY_PEM']);
    }
    const kid = config.JWT_KID ?? (await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: derived.x! }));
    return createKeyStore(priv, kid, ttl);
  }
  if (config.APP_MODE === 'production') throw new ConfigError(['JWT_PRIVATE_KEY_PEM: required when APP_MODE=production']);

  const SigningKey = SigningKeyModel(conn);
  const fieldKey = config.FIELD_ENCRYPTION_KEY;
  let doc = await SigningKey.findOne({ slot: 'active' }).lean();
  if (!doc) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ format: 'jwk' }) as JWK;
    const kid = await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: pub.x! });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    try {
      await SigningKey.create({
        _id: kid,
        alg: 'EdDSA',
        slot: 'active',
        publicJwk: publicJwkOf(publicKey, kid) as Record<string, unknown>,
        privateKeyEnc: encryptField(pem, fieldKey),
      });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e; // another instance won the race
    }
    doc = await SigningKey.findOne({ slot: 'active' }).lean();
    if (!doc) throw new Error('signing key bootstrap failed');
  }
  const priv = createPrivateKey(decryptField(doc.privateKeyEnc, fieldKey));
  return createKeyStore(priv, doc._id, ttl);
}
