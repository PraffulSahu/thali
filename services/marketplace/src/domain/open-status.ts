/**
 * Open/closed status in the restaurant's timezone (default Asia/Kolkata) — Review Focus #1.
 *
 * Hours slots are `{ day 0=Sun..6=Sat, open "HH:mm", close "HH:mm" }` in LOCAL time:
 *  - open < close  → same-day slot [open, close)
 *  - close < open  → overnight slot: [open, 24:00) on `day` and [00:00, close) on `day + 1`
 *  - close == open → 24 h starting at `open` (so "00:00–00:00" = all day)
 * The weekday is always taken from the local (IST) calendar, never from UTC.
 */
import type { RestaurantStatus } from '@thali/contracts';

export interface HoursSlot {
  day: number;
  open: string;
  close: string;
}

export interface OpenStatusInput {
  status: RestaurantStatus | string;
  hours?: HoursSlot[] | null;
  timezone?: string | null;
  pausedUntil?: Date | null;
}

export type ClosedReason = 'PAUSED' | 'OUTSIDE_HOURS' | 'NOT_APPROVED';

export interface OpenStatus {
  open: boolean;
  reason?: ClosedReason;
  nextOpenAt?: Date;
}

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

interface LocalParts {
  y: number;
  mo: number;
  d: number;
  /** minutes since local midnight (seconds truncated) */
  min: number;
  /** local weekday 0=Sun */
  dow: number;
}

function localParts(date: Date, tz: string): LocalParts {
  const parts = Object.fromEntries(formatter(tz).formatToParts(date).map((p) => [p.type, p.value]));
  const y = Number(parts.year);
  const mo = Number(parts.month);
  const d = Number(parts.day);
  const min = Number(parts.hour) * 60 + Number(parts.minute);
  return { y, mo, d, min, dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
}

/** Offset (local − UTC) in ms at `instant` (whole-minute offsets, so seconds carry over). */
function tzOffsetMs(instant: number, tz: string): number {
  const t = Math.floor(instant / 1000) * 1000;
  const p = localParts(new Date(t), tz);
  return Date.UTC(p.y, p.mo - 1, p.d, 0, p.min, new Date(t).getUTCSeconds()) - t;
}

/** UTC instant of local calendar date (y, mo, d + dayOffset) at `minutes` past local midnight. */
function zonedToUtc(y: number, mo: number, d: number, minutes: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, 0, minutes);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz); // second pass handles DST edges (no-op for IST)
  return new Date(t);
}

/** Is `date` inside the weekly hours (ignores status / pause)? */
export function isWithinHours(hours: HoursSlot[], date: Date, tz = DEFAULT_TIMEZONE): boolean {
  const { dow, min } = localParts(date, tz);
  const prev = (dow + 6) % 7;
  return hours.some((s) => {
    const o = toMin(s.open);
    const c = toMin(s.close);
    if (o < c) return s.day === dow && min >= o && min < c;
    // overnight (or 24 h when equal)
    return (s.day === dow && min >= o) || (s.day === prev && min < c);
  });
}

/** First slot start strictly after `date` (within the next 8 local days), or undefined. */
export function nextSlotStart(hours: HoursSlot[], date: Date, tz = DEFAULT_TIMEZONE): Date | undefined {
  if (!hours.length) return undefined;
  const p = localParts(date, tz);
  let best: Date | undefined;
  for (let k = 0; k <= 7; k++) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + k));
    const dow = day.getUTCDay();
    for (const s of hours) {
      if (s.day !== dow) continue;
      const start = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), toMin(s.open), tz);
      if (start.getTime() > date.getTime() && (!best || start < best)) best = start;
    }
    if (best) return best;
  }
  return best;
}

/** First instant ≥ `from` at which the hours are open. */
function firstOpenAtOrAfter(hours: HoursSlot[], from: Date, tz: string): Date | undefined {
  if (isWithinHours(hours, from, tz)) return from;
  return nextSlotStart(hours, from, tz);
}

/**
 * Open status of a restaurant at `date`. Only APPROVED restaurants can be open.
 * `nextOpenAt` is given for PAUSED / OUTSIDE_HOURS when the hours define one.
 */
export function isOpenAt(restaurant: OpenStatusInput, date: Date): OpenStatus {
  if (restaurant.status !== 'APPROVED') return { open: false, reason: 'NOT_APPROVED' };
  const tz = restaurant.timezone || DEFAULT_TIMEZONE;
  const hours = restaurant.hours ?? [];
  const paused = restaurant.pausedUntil && restaurant.pausedUntil.getTime() > date.getTime() ? restaurant.pausedUntil : null;
  if (paused) {
    const next = firstOpenAtOrAfter(hours, paused, tz);
    return next ? { open: false, reason: 'PAUSED', nextOpenAt: next } : { open: false, reason: 'PAUSED' };
  }
  if (isWithinHours(hours, date, tz)) return { open: true };
  const next = nextSlotStart(hours, date, tz);
  return next ? { open: false, reason: 'OUTSIDE_HOURS', nextOpenAt: next } : { open: false, reason: 'OUTSIDE_HOURS' };
}
