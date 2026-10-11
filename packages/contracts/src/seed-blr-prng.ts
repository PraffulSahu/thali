/**
 * Seeded PRNG helpers for the Bengaluru seed generator (`@thali/contracts/seed-blr`). Pure and
 * deterministic: every entity draws from its own named stream (`rng('restaurant:17')`), so adding a draw
 * to one entity never shifts the values of another.
 */

/** 32-bit FNV-1a hash of a string. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** Uniform [0, 1). */
  next(): number;
  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** true with probability p. */
  chance(p: number): boolean;
  pick<T>(arr: readonly T[]): T;
  /** Index chosen with probability proportional to `weights[i]` (all ≥ 0, sum > 0). */
  weightedIndex(weights: readonly number[]): number;
  weighted<T>(items: readonly T[], weight: (t: T) => number): T;
  /** Fisher-Yates copy. */
  shuffle<T>(arr: readonly T[]): T[];
  /** `n` distinct elements (all of them when n ≥ length). */
  sample<T>(arr: readonly T[], n: number): T[];
  /** Standard normal (Box-Muller). */
  normal(mean?: number, sd?: number): number;
}

/** mulberry32 stream seeded from `hash32('thali-blr:' + key)`. */
export function rng(key: string): Rng {
  let a = hash32(`thali-blr:${key}`) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (arr) => {
      if (!arr.length) throw new RangeError('pick from an empty array');
      return arr[Math.floor(next() * arr.length)]!;
    },
    weightedIndex: (weights) => {
      let total = 0;
      for (const w of weights) total += w;
      if (!(total > 0)) throw new RangeError('weightedIndex needs a positive total weight');
      let x = next() * total;
      for (let i = 0; i < weights.length; i++) {
        x -= weights[i]!;
        if (x < 0) return i;
      }
      return weights.length - 1;
    },
    weighted: (items, weight) => items[r.weightedIndex(items.map(weight))]!,
    shuffle: (arr) => {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
    sample: (arr, n) => r.shuffle(arr).slice(0, Math.max(0, n)),
    normal: (mean = 0, sd = 1) => {
      const u = Math.max(next(), 1e-12);
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
  return r;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** `n` Crockford base-32 characters (order codes use 8). */
export function crockford(r: Rng, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += CROCKFORD[r.int(0, 31)];
  return s;
}

/** Great-circle distance in km. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371.0088;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Point `km` away from `p` at `bearing` radians (flat-earth approximation, fine at city scale). */
export function offsetKm(p: { lat: number; lng: number }, km: number, bearing: number): { lat: number; lng: number } {
  const dLat = (km * Math.cos(bearing)) / 110.574;
  const dLng = (km * Math.sin(bearing)) / (111.32 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: round5(p.lat + dLat), lng: round5(p.lng + dLng) };
}

export const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
