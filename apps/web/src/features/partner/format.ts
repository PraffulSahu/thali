/**
 * Partner-area display helpers (pure, unit-tested in test/partner/format.test.ts).
 */
import { formatINR } from '../../lib/format';
import type { DeliveryStatusValue } from './api';

/** Server default CODE_MAX_ATTEMPTS (PRD: "after 5 wrong → locked"). Only used in copy; the server counts. */
export const CODE_MAX_ATTEMPTS = 5;

/** Default offer window (OFFER_TTL_SEC 45 s). The ring uses max(45, first seen remaining). */
export const OFFER_WINDOW_SEC = 45;

/** 1 → "1st", 2 → "2nd", 3 → "3rd", 4 → "4th". */
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * Batching reason from the delivery service ("pickup 0.8km ≤ 1.5km ✓", "extra 8.0min ≤ 12min ✓") →
 * `{ ok, text: "pickup 0.8 km ≤ 1.5 km" }` / `"extra time 8 min ≤ 12 min"` (board 30 fit list).
 */
export function formatReason(reason: string): { ok: boolean; text: string } {
  const trimmed = reason.trim();
  const ok = !trimmed.endsWith('✗');
  const text = trimmed
    .replace(/\s*[✓✗]$/, '')
    .replace(/(\d+)\.0(?=\s*(km|min)\b)/g, '$1')
    .replace(/(\d)(km|min)\b/g, '$1 $2')
    .replace(/^extra (?!time)/, 'extra time ');
  return { ok, text };
}

/** Reasons worth listing in the fit box (the idle-partner line says nothing about a 2nd delivery). */
export function fitReasons(reasons: string[]) {
  // "active 1 < max 2 ✓" is already said by "would be your 2nd delivery"; keep it only when it fails.
  return reasons
    .filter((r) => !/^idle partner/.test(r.trim()) && !(/^active \d/.test(r.trim()) && r.trim().endsWith('✓')))
    .map(formatReason);
}

/** Whole rupees without paise ("₹642"), otherwise the full amount ("₹642.50"). */
export function formatRupeesShort(paise: number): string {
  if (!Number.isSafeInteger(paise)) return '₹ -';
  const full = formatINR(paise);
  return paise % 100 === 0 ? full.replace(/\.00$/, '') : full;
}

/** "4021883311 90" → "4021 8833 1190" (UTR grouped by 4 for reading aloud). */
export function groupUtr(utr: string): string {
  return utr.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ');
}

/** Monday 00:00 in Asia/Kolkata for the week containing `now`, as an ISO string with +05:30 offset. */
export function istWeekStart(now: number = Date.now()): string {
  const ist = new Date(now + 330 * 60_000); // shift so the UTC getters read IST wall time
  const daysSinceMonday = (ist.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - daysSinceMonday));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}T00:00:00+05:30`;
}

/**
 * Job status → index of the CURRENT step in PARTNER_STEPS (At restaurant · Picked up · On the way · Deliver).
 * The current step is the one the partner is working on next.
 */
export function partnerStep(status: DeliveryStatusValue): number {
  switch (status) {
    case 'ASSIGNED':
      return 0;
    case 'AT_PICKUP':
      return 1;
    case 'PICKED_UP':
      return 2;
    case 'OUT_FOR_DELIVERY':
      return 3;
    case 'DELIVERED':
      return 4;
    default:
      return 0;
  }
}

/** Before pickup the partner heads to the restaurant; afterwards to the customer. */
export function isPrePickup(status: DeliveryStatusValue): boolean {
  return status === 'ASSIGNED' || status === 'AT_PICKUP' || status === 'OFFERED' || status === 'PENDING_ASSIGNMENT';
}

/** "Prafful · Home" — name plus the address label when there is one. */
export function dropTitle(name: string, label: string | null | undefined): string {
  return label ? `${name} · ${label}` : name;
}
