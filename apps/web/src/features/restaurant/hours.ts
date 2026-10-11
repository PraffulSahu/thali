/** Weekly opening-hours model shared by the onboarding wizard and the store settings page. */
import type { HoursSlot } from '@thali/contracts';

export interface TimeSlot {
  open: string;
  close: string;
}
/** Day number (0 = Sunday ... 6 = Saturday, restaurant timezone) -> slots. */
export type WeekState = Record<number, TimeSlot[]>;

export const MAX_SLOTS_PER_DAY = 3;
export const MAX_SLOTS_TOTAL = 21;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export const emptyWeek = (): WeekState => ({ 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] });

export function weekFromSlots(hours: HoursSlot[]): WeekState {
  const w = emptyWeek();
  for (const h of hours) w[h.day]?.push({ open: h.open, close: h.close });
  for (const d of Object.keys(w)) w[Number(d)]!.sort((a, b) => a.open.localeCompare(b.open));
  return w;
}

export function slotsFromWeek(week: WeekState): HoursSlot[] {
  const out: HoursSlot[] = [];
  for (let day = 0; day <= 6; day++) for (const s of week[day] ?? []) out.push({ day, open: s.open, close: s.close });
  return out;
}

export const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** close before open = closes after midnight; open == close = open 24 hours (server semantics). */
export const slotKind = (s: TimeSlot): 'normal' | 'overnight' | 'allDay' =>
  s.close === s.open ? 'allDay' : toMinutes(s.close) < toMinutes(s.open) ? 'overnight' : 'normal';

export interface WeekValidation {
  /** key `${day}.${index}` or `week` -> message */
  errors: Record<string, string>;
  valid: boolean;
}

export function validateWeek(week: WeekState): WeekValidation {
  const errors: Record<string, string> = {};
  let total = 0;
  for (let day = 0; day <= 6; day++) {
    const slots = week[day] ?? [];
    total += slots.length;
    slots.forEach((s, i) => {
      if (!HHMM.test(s.open) || !HHMM.test(s.close)) errors[`${day}.${i}`] = 'Enter both an opening and a closing time.';
    });
    if (slots.length > 1) {
      const ok = slots.map((s, i) => ({ s, i })).filter(({ s }) => HHMM.test(s.open) && HHMM.test(s.close));
      const sorted = [...ok].sort((a, b) => toMinutes(a.s.open) - toMinutes(b.s.open));
      for (let k = 1; k < sorted.length; k++) {
        const prev = sorted[k - 1]!;
        const cur = sorted[k]!;
        const prevEnd = slotKind(prev.s) === 'normal' ? toMinutes(prev.s.close) : 1440;
        if (toMinutes(cur.s.open) < prevEnd && !errors[`${day}.${cur.i}`]) errors[`${day}.${cur.i}`] = 'This overlaps the previous slot.';
      }
    }
  }
  if (total === 0) errors.week = 'Add opening hours for at least one day.';
  if (total > MAX_SLOTS_TOTAL) errors.week = `At most ${MAX_SLOTS_TOTAL} slots are allowed.`;
  return { errors, valid: Object.keys(errors).length === 0 };
}

/** "Mon-Fri 09:00-22:00" style one-line summary for review screens. */
export function summarizeHours(hours: HoursSlot[]): string[] {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const w = weekFromSlots(hours);
  return [1, 2, 3, 4, 5, 6, 0]
    .filter((d) => w[d]!.length)
    .map((d) => `${names[d]} ${w[d]!.map((s) => `${s.open}-${s.close}`).join(', ')}`);
}

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/**
 * Next time a slot opens after `now` (hours are Asia/Kolkata wall-clock times; IST has no DST), searching the
 * coming 7 days. null when the week has no slots. Used for "Closed · opens 6:00 PM".
 */
export function nextOpening(hours: HoursSlot[], now: number = Date.now()): Date | null {
  if (!hours.length) return null;
  const ist = now + IST_OFFSET_MS;
  const dayStart = ist - (ist % DAY_MS);
  for (let d = 0; d <= 7; d++) {
    const start = dayStart + d * DAY_MS;
    const weekday = new Date(start).getUTCDay();
    const opens = hours
      .filter((h) => h.day === weekday)
      .map((h) => start + toMinutes(h.open) * 60_000 - IST_OFFSET_MS)
      .filter((t) => t > now)
      .sort((a, b) => a - b);
    if (opens.length) return new Date(opens[0]!);
  }
  return null;
}

/** IST calendar-day key, to tell "today" from a later day. */
export function istDayKey(t: number): number {
  const ist = t + IST_OFFSET_MS;
  return ist - (ist % DAY_MS);
}
