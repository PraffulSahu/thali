/**
 * Display formatting. All dates render in Asia/Kolkata with the en-IN locale, whatever the device timezone
 * (timestamps are UTC ISO strings from the API). Money is integer paise -> `formatINR` (contracts).
 *
 *   formatDateTime('2026-10-10T07:30:00Z')   -> "10 Oct 2026, 1:00 pm"
 *   formatTime(iso)                          -> "1:00 pm"
 *   formatDate(iso)                          -> "10 Oct 2026"
 *   formatRelative(iso)                      -> "12s ago" / "5 min ago" / "in 3 min"
 *   formatDuration(299)                      -> "4:59"
 *   formatDistanceKm(2.345)                  -> "2.3 km"
 */
import { formatINR } from '@thali/contracts';

export { formatINR };
export const DISPLAY_TIMEZONE = 'Asia/Kolkata';
export const DISPLAY_LOCALE = 'en-IN';

type DateInput = string | number | Date | null | undefined;

function toDate(v: DateInput): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const cache = new Map<string, Intl.DateTimeFormat>();
export function istFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(DISPLAY_LOCALE, { timeZone: DISPLAY_TIMEZONE, ...options });
    cache.set(key, f);
  }
  return f;
}

export function formatDate(v: DateInput, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string {
  const d = toDate(v);
  return d ? istFormatter(options).format(d) : '';
}

export function formatTime(v: DateInput): string {
  const d = toDate(v);
  return d ? istFormatter({ hour: 'numeric', minute: '2-digit', hour12: true }).format(d) : '';
}

export function formatDateTime(v: DateInput): string {
  const d = toDate(v);
  return d
    ? istFormatter({ day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(d)
    : '';
}

/** Short relative time. `now` is injectable for tests and the shared ticker. */
export function formatRelative(v: DateInput, now: number = Date.now()): string {
  const d = toDate(v);
  if (!d) return '';
  const diff = Math.round((now - d.getTime()) / 1000);
  const abs = Math.abs(diff);
  const future = diff < 0;
  let s: string;
  if (abs < 5) return 'just now';
  if (abs < 60) s = `${abs}s`;
  else if (abs < 3600) s = `${Math.floor(abs / 60)} min`;
  else if (abs < 86_400) s = `${Math.floor(abs / 3600)} h`;
  else if (abs < 7 * 86_400) s = `${Math.floor(abs / 86_400)} d`;
  else return formatDate(d);
  return future ? `in ${s}` : `${s} ago`;
}

/** Seconds -> "m:ss" (or "h:mm:ss" past an hour). Negative clamps to 0. */
export function formatDuration(totalSeconds: number): string {
  const t = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatDistanceKm(km: number): string {
  if (!Number.isFinite(km)) return '';
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

/** "+919876543210" -> "+91 98765 43210" (display only). */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

/** Basis points -> "5%" / "12.5%". */
export function formatBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, '')}%`;
}

/** Plural helper: plural(2, 'item') -> "2 items". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
