/** `GET /api/v1/meta` — public platform facts the SPA needs for its mode banner (LLD 10, gateway). */
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { AppMode } from '@thali/contracts';
import type { GatewayConfig } from './config.js';

export const ProviderLabelSchema = z.enum(['live', 'sandbox', 'demo']);
export type ProviderLabel = z.infer<typeof ProviderLabelSchema>;

export const MetaSchema = z
  .object({
    mode: z.enum(['demo', 'sandbox', 'production']),
    brand: z.string(),
    currency: z.literal('INR'),
    timezone: z.literal('Asia/Kolkata'),
    /** GW-3: the city the platform serves (static config). */
    city: z.object({ name: z.string(), pilot: z.boolean() }),
    providers: z.object({
      payment: ProviderLabelSchema,
      sms: ProviderLabelSchema,
      email: ProviderLabelSchema,
      maps: ProviderLabelSchema,
      storage: ProviderLabelSchema,
    }),
  })
  .meta({ id: 'GatewayMeta' });
export type Meta = z.infer<typeof MetaSchema>;

/** Providers that never talk to a real third party. */
const SIMULATED = new Set(['mock', 'demo', 'mailpit']);

/**
 * How the UI should label a provider:
 *  - `APP_MODE=demo` -> `demo` (whole platform is a demo; data and flows are simulated)
 *  - a simulated provider (mock / demo geo / mailpit) in any mode -> `demo`
 *  - real provider in `sandbox` -> `sandbox` (provider test credentials); in `production` -> `live`
 */
export function providerLabel(mode: AppMode, provider: string): ProviderLabel {
  if (mode === 'demo') return 'demo';
  if (SIMULATED.has(provider)) return 'demo';
  return mode === 'production' ? 'live' : 'sandbox';
}

export function buildMeta(config: GatewayConfig): Meta {
  const mode = config.APP_MODE;
  return {
    mode,
    brand: config.BRAND_NAME,
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    city: { name: config.CITY_NAME, pilot: config.CITY_PILOT },
    providers: {
      payment: providerLabel(mode, config.PAYMENT_PROVIDER),
      sms: providerLabel(mode, config.SMS_PROVIDER),
      email: providerLabel(mode, config.EMAIL_PROVIDER),
      maps: providerLabel(mode, config.GEO_PROVIDER),
      storage: providerLabel(mode, config.STORAGE_PROVIDER),
    },
  };
}

export function metaHandler(config: GatewayConfig): RequestHandler {
  const body = buildMeta(config);
  return (_req, res) => {
    res.setHeader('cache-control', 'public, max-age=60');
    res.json(body);
  };
}
