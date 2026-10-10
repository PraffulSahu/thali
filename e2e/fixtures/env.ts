/**
 * Shared constants for the e2e suite (demo stack from `docker-compose.yml` + `npm run seed`).
 * Override the URLs with E2E_WEB_URL / E2E_API_URL / E2E_MAILPIT_URL when the host ports differ.
 */
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB_URL = (process.env.E2E_WEB_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
/** Gateway published directly (used for flow 12 and the docs pages). */
export const GATEWAY_URL = (process.env.E2E_API_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
/** Mailpit HTTP API of the full stack (MAILPIT_HOST_PORT; 18025 when the infra stack owns 8025). */
export const MAILPIT_URL = (process.env.E2E_MAILPIT_URL ?? 'http://localhost:18025').replace(/\/+$/, '');
/** API calls go through nginx exactly like the browser. */
export const API_BASE = `${WEB_URL}/api/v1`;

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEMO_OTP = '123456';

/** Demo phones (DEMO_PHONES in compose). Each spec uses its own phones to stay inside the OTP limits. */
export const PHONES = {
  consumer1: '+919000000001', // Asha Rao
  consumer2: '+919000000002', // Vikram Shah
  consumer3: '+919000000003', // Meera Iyer
  owner1: '+919100000001', // Spice Route (+ Tandoor Tales)
  owner2: '+919100000002', // Green Leaf (+ Coastal Curry House)
  partner1: '+919200000001', // APPROVED
  partner2: '+919200000002', // APPROVED (offline)
} as const;
export type DemoUser = keyof typeof PHONES;

export const ADMIN_EMAIL = 'admin@thali.demo';
export const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'ThaliDemo#2026';
/** services/identity/src/seed.ts DEFAULT_DEMO_ADMIN_TOTP_SECRET (override: SEED_ADMIN_TOTP_SECRET). */
export const ADMIN_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET || 'THALIDEMOTOTPSECRETKEY234567ABCD';

/** Koramangala points inside the seeded service area. */
export const GEO = {
  consumer1Home: { latitude: 12.9338, longitude: 77.6309 },
  nearSpiceRoute: { latitude: 12.9349, longitude: 77.6251 },
  /** Connaught Place, New Delhi: outside every demo service area. */
  outside: { latitude: 28.6315, longitude: 77.2167 },
} as const;

/** Same as `@thali/contracts/seed` seedId (deterministic ids shared by all seeds). */
export function seedId(name: string): string {
  return createHash('sha1').update(`thali-seed:${name}`).digest('hex').slice(0, 24);
}

export const RESTAURANTS = {
  spiceRoute: { id: seedId('restaurant:spice-route'), slug: 'spice-route', name: 'Spice Route' },
  greenLeaf: { id: seedId('restaurant:green-leaf'), slug: 'green-leaf', name: 'Green Leaf' },
  tandoorTales: { id: seedId('restaurant:tandoor-tales'), slug: 'tandoor-tales', name: 'Tandoor Tales' },
  coastalCurry: { id: seedId('restaurant:coastal-curry'), slug: 'coastal-curry', name: 'Coastal Curry House' },
} as const;

/** Items without customization groups (simple to add from the UI and the API). */
export const SIMPLE_ITEMS = {
  paneerTikka: { restaurant: RESTAURANTS.spiceRoute, name: 'Paneer Tikka', pricePaise: 22900 },
  dalMakhani: { restaurant: RESTAURANTS.greenLeaf, name: 'Dal Makhani', pricePaise: 21900 },
  idliVada: { restaurant: RESTAURANTS.greenLeaf, name: 'Idli Vada Combo', pricePaise: 11900 },
} as const;

/** Mirror of `@thali/contracts` formatINR (what the UI renders): ₹1,23,456.78. */
export function formatINR(paise: number): string {
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100).toString();
  const frac = (abs % 100).toString().padStart(2, '0');
  const grouped = rupees.length <= 3 ? rupees : `${rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${rupees.slice(-3)}`;
  return `${paise < 0 ? '-' : ''}₹${grouped}.${frac}`;
}

/** 10-digit national number as typed into the sign-in form. */
export const national = (phone: string) => phone.replace(/^\+91/, '');

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Unique-ish marker for data created by this run (addresses, restaurant names). */
export const runTag = () => `e2e-${Date.now().toString(36)}`;
