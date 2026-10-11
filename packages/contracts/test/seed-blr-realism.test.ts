/**
 * Seed realism (final fix round 3a/3b): Discover pages must look like a real city.
 *  - covers are near-unique: no cover photo repeats within the first two discovery pages (40 cards) around the busy
 *    localities at any time of day, and never twice within one locality;
 *  - branches of one brand never share a locality, sit well apart, and never show up twice on those pages.
 * Discovery is simulated like marketplace: APPROVED, within the restaurant's delivery radius, open first, then distance.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as pricing from '@thali/pricing';
import { EMPTY_MANIFEST, buildBlrWorld, haversineKm, loadBlrData, type BlrRestaurant, type BlrWorld } from '../src/seed-blr.js';

const data = loadBlrData();
let w: BlrWorld;
beforeAll(() => {
  w = buildBlrWorld({ pricing, anchor: new Date('2026-10-11T08:00:00.000Z'), data, manifest: EMPTY_MANIFEST, counts: { checkouts: 50 } });
}, 30_000);

const PAGES = 2;
const PAGE_SIZE = 20;
const LOCALITIES = ['Indiranagar', 'Koramangala 5th Block', 'Koramangala 6th Block', 'HSR Layout', 'BTM Layout', 'Whitefield', 'Jayanagar'];
const MINUTES = [6 * 60 + 45, 9 * 60, 12 * 60 + 30, 16 * 60 + 30, 20 * 60, 23 * 60 + 15, 2 * 60];
const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

function openAt(r: BlrRestaurant, day: number, m: number): boolean {
  return r.hours.some((h) => {
    const [o, c] = [hm(h.open), hm(h.close)];
    if (c > o) return h.day === day && m >= o && m < c;
    return (h.day === day && m >= o) || (h.day === (day + 6) % 7 && m < c); // crosses midnight
  });
}

function discover(at: { lat: number; lng: number }, day: number, m: number): BlrRestaurant[] {
  return w.restaurants
    .filter((r) => r.status === 'APPROVED')
    .map((r) => ({ r, km: haversineKm(r.location, at), open: openAt(r, day, m) }))
    .filter((x) => x.km <= x.r.deliveryRadiusKm)
    .sort((a, b) => (a.open === b.open ? a.km - b.km || (a.r.id < b.r.id ? -1 : 1) : a.open ? -1 : 1))
    .slice(0, PAGES * PAGE_SIZE)
    .map((x) => x.r);
}

const dupes = (xs: (string | number | null)[]) => [...new Set(xs.filter((x, i) => x !== null && xs.indexOf(x) !== i))];

describe('seed realism: covers', () => {
  it('no cover repeats within the first two discovery pages of the busy localities, at any time of day', () => {
    const problems: string[] = [];
    for (const name of LOCALITIES) {
      const loc = data.localities.find((l) => l.name === name)!;
      for (const day of [0, 3]) {
        for (const m of MINUTES) {
          const page = discover(loc, day, m);
          expect(page.length).toBeGreaterThanOrEqual(PAGE_SIZE);
          const d = dupes(page.map((r) => r.coverImageId));
          if (d.length) problems.push(`${name} day ${day} ${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}: ${d.join(', ')}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('no cover repeats within any locality; every restaurant has a cover', () => {
    for (const r of w.restaurants) expect(r.coverImageId).toBeTruthy();
    const byLoc = new Map<string, BlrRestaurant[]>();
    for (const r of w.restaurants) byLoc.set(r.locality.name, [...(byLoc.get(r.locality.name) ?? []), r]);
    const problems = [...byLoc].flatMap(([name, rs]) => dupes(rs.map((r) => r.coverImageId)).map((c) => `${name}: ${c}`));
    expect(problems).toEqual([]);
  });

  it('covers stay food-forward: a dish of the restaurant’s own menu, or a curated café / bakery / sweet-shop cover', () => {
    const imgs = new Map(data.images.map((i) => [i.id, i]));
    for (const r of w.restaurants) {
      const img = imgs.get(r.coverImageId!)!;
      if (img.kind === 'restaurant-cover') expect(['cafe', 'bakery', 'desserts', 'ice-cream']).toContain(r.primaryCuisine);
      else {
        expect(img.kind).toBe('dish');
        const menuDishes = new Set(r.items.map((i) => i.dishId));
        expect(data.dishes.some((d) => menuDishes.has(d.id) && d.imageIds.includes(img.id))).toBe(true);
      }
    }
  });
});

describe('seed realism: branches', () => {
  it('branches of one brand never share a locality and are at least 5 km apart', () => {
    const byBrand = new Map<number, BlrRestaurant[]>();
    for (const r of w.restaurants) byBrand.set(r.brand, [...(byBrand.get(r.brand) ?? []), r]);
    const close: string[] = [];
    for (const rs of byBrand.values()) {
      expect(new Set(rs.map((r) => r.locality.name)).size).toBe(rs.length);
      for (let a = 0; a < rs.length; a++)
        for (let b = a + 1; b < rs.length; b++) {
          const km = haversineKm(rs[a]!.location, rs[b]!.location);
          if (km < 5) close.push(`${rs[a]!.name}: ${rs[a]!.locality.name} / ${rs[b]!.locality.name} ${km.toFixed(1)} km`);
        }
    }
    expect(close).toEqual([]);
  });

  it('a brand never appears twice on the first two discovery pages of the busy localities', () => {
    const problems: string[] = [];
    for (const name of LOCALITIES) {
      const loc = data.localities.find((l) => l.name === name)!;
      for (const m of MINUTES) {
        const page = discover(loc, 3, m);
        const d = dupes(page.map((r) => r.brand));
        if (d.length) problems.push(`${name} ${m}: ${d.map((b) => page.find((r) => r.brand === b)!.name).join(', ')}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
