/**
 * Pure helpers for the owner order cards (board 20): option text, one-line item summaries, prep progress and
 * the delivery-partner line. Kept free of React so they are unit-tested directly.
 */
import type { OwnerOrder, OwnerOrderLine } from './api';

/** Prep choices drawn on the card (design-spec 20-24…20-27). */
export const PREP_PILLS = [10, 15, 20, 30] as const;

/** "Full · Extra raita" — the order view's `addOns` carry every chosen option (size included), in menu order. */
export function optionText(line: Pick<OwnerOrderLine, 'addOns'>): string {
  return (line.addOns ?? []).map((a) => a.name).filter(Boolean).join(' · ');
}

/** "3× Mutton Seekh Kebab · 2× Rumali Roti" (preparing / ready cards). */
export function itemsLine(order: Pick<OwnerOrder, 'lines'>): string {
  return order.lines.map((l) => `${l.quantity}× ${l.name}`).join(' · ');
}

/** Customer first name ("Ananya Rao" → "Ananya"); empty when unknown. */
export function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

/** "+91******3210" → "+91 ••••• •3210" (board 20 header). Anything else is shown as given. */
export function maskedPhone(masked: string | null | undefined): string {
  if (!masked) return '';
  const m = /^\+91[*•x]*(\d{4})$/i.exec(masked.replace(/\s+/g, ''));
  return m ? `+91 ••••• •${m[1]}` : masked;
}

/** Default prep pill: the restaurant's average when it is one of the pills, else 20. */
export function defaultPrep(avgPrepMinutes: number | null | undefined): number {
  return avgPrepMinutes && (PREP_PILLS as readonly number[]).includes(avgPrepMinutes) ? avgPrepMinutes : 20;
}

export interface PrepProgress {
  /** whole minutes since acceptance (≥ 0) */
  elapsed: number;
  /** whole minutes promised (acceptedAt → readyEta, else prepMinutes) */
  total: number;
  overdue: boolean;
  /** "13 of 20 min" / "4 min over" */
  text: string;
}

/**
 * Progress of an accepted order from `acceptedAt` + `readyEta` (the server moves readyEta when the prep time is
 * changed) or `prepMinutes`. null when the order has no acceptance time.
 */
export function prepProgress(o: Pick<OwnerOrder, 'acceptedAt' | 'readyEta' | 'prepMinutes'>, now: number = Date.now()): PrepProgress | null {
  const start = o.acceptedAt ? Date.parse(o.acceptedAt) : NaN;
  if (Number.isNaN(start)) return null;
  const eta = o.readyEta ? Date.parse(o.readyEta) : NaN;
  const totalMs = !Number.isNaN(eta) && eta > start ? eta - start : (o.prepMinutes ?? 0) * 60_000;
  if (totalMs <= 0) return null;
  const total = Math.max(1, Math.round(totalMs / 60_000));
  const elapsedMs = Math.max(0, now - start);
  const elapsed = Math.floor(elapsedMs / 60_000);
  const overdue = elapsedMs > totalMs;
  const over = Math.max(1, Math.ceil((elapsedMs - totalMs) / 60_000));
  return { elapsed: Math.min(elapsed, total), total, overdue, text: overdue ? `${over} min over` : `${Math.min(elapsed, total)} of ${total} min` };
}

const FINDING = new Set(['PENDING_ASSIGNMENT', 'OFFERED']);

/** Rider line: "Finding partner" · "Imran assigned" · "Ravi · at restaurant" · "Picked up". */
export function partnerText(o: Pick<OwnerOrder, 'deliveryStatus' | 'partner'>): string {
  const s = o.deliveryStatus ?? null;
  const name = firstName(o.partner?.name);
  if (s === null || FINDING.has(s)) return 'Finding partner';
  if (s === 'ASSIGNED') return name ? `${name} assigned` : 'Partner assigned';
  if (s === 'AT_PICKUP') return name ? `${name} · at restaurant` : 'Partner at restaurant';
  if (s === 'PICKED_UP' || s === 'OUT_FOR_DELIVERY') return name ? `${name} · picked up` : 'Picked up';
  if (s === 'FAILED') return 'Delivery failed';
  if (s === 'CANCELLED') return 'Delivery cancelled';
  return name || 'Partner';
}

/** True once a partner is attached to the order (assigned or at the restaurant). */
export function hasPartner(o: Pick<OwnerOrder, 'deliveryStatus'>): boolean {
  return o.deliveryStatus === 'ASSIGNED' || o.deliveryStatus === 'AT_PICKUP';
}

/** Seconds → "1m 12s" / "45s" (KPI "Avg. time to accept"). */
export function shortDuration(totalSeconds: number): string {
  const t = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(t / 60);
  const s = t % 60;
  if (m === 0) return `${s}s`;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** 0.94 → "94%", 0.875 → "87.5%". */
export function percent(fraction: number): string {
  const p = Math.round(fraction * 1000) / 10;
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
}
