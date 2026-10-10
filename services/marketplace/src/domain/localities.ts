/**
 * Demo / fallback gazetteer (MKT-1) over the `localities` collection.
 *
 * `upsertLocalities(conn, rows)` is the loader Task 8's seed calls with
 * `scripts/seed-data/localities.json` rows (`{name, pincode, lat, lng, streets[]}`): one LOCALITY row per
 * locality plus one ROAD row `"<street>, <locality>"` per street. Ids are deterministic, writes are
 * upserts, so re-running is idempotent and picks up edits.
 *
 * When the collection is empty outside production, the first lookup lazily loads
 * `${SEED_DATA_DIR}/localities.json` (default `<repo>/scripts/seed-data`). A missing file (e.g. inside a
 * Docker image) just means empty results.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Types, type Connection } from 'mongoose';
import type { LatLng } from '@thali/service-kit';
import { localityModel, type LocalityDoc } from '../models/locality.js';

export interface LocalitySeedRow {
  name: string;
  pincode?: string | null;
  lat: number;
  lng: number;
  streets?: string[];
  aliases?: string[];
  city?: string;
}

export type LocalityLean = LocalityDoc & { _id: Types.ObjectId };

const idFor = (key: string) => new Types.ObjectId(createHash('sha1').update(`thali-locality:${key.toLowerCase()}`).digest('hex').slice(0, 24));

/** Lower-cased, accent-free words. */
export function tokenize(...parts: (string | null | undefined)[]): string[] {
  const words = parts
    .filter((p): p is string => !!p)
    .join(' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return [...new Set(words)];
}

const point = (lat: number, lng: number) => ({ type: 'Point' as const, coordinates: [lng, lat] });

/** Idempotent upsert of gazetteer rows. Returns how many LOCALITY and ROAD rows were written. */
export async function upsertLocalities(conn: Connection, rows: readonly LocalitySeedRow[]): Promise<{ localities: number; roads: number }> {
  const Locality = localityModel(conn);
  const now = new Date();
  const ops: Parameters<typeof Locality.bulkWrite>[0] = [];
  let localities = 0;
  let roads = 0;
  for (const r of rows) {
    const name = r.name?.trim();
    if (!name || !Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue;
    const city = r.city?.trim() || 'Bengaluru';
    const pincode = r.pincode ? String(r.pincode).trim() : null;
    const aliases = (r.aliases ?? []).map((a) => a.trim()).filter(Boolean);
    localities++;
    ops.push({
      updateOne: {
        filter: { _id: idFor(`${city}|${name}`) },
        update: {
          $set: { name, primary: name, aliases, kind: 'LOCALITY', locality: name, city, pincode, location: point(r.lat, r.lng), tokens: tokenize(name, ...aliases), isDemo: true, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        upsert: true,
      },
    });
    for (const s of new Set((r.streets ?? []).map((x) => x.trim()).filter(Boolean))) {
      roads++;
      const roadName = `${s}, ${name}`;
      ops.push({
        updateOne: {
          filter: { _id: idFor(`${city}|${name}|${s}`) },
          update: {
            $set: { name: roadName, primary: s, aliases: [], kind: 'ROAD', locality: name, city, pincode, location: point(r.lat, r.lng), tokens: tokenize(s, name, ...aliases), isDemo: true, updatedAt: now },
            $setOnInsert: { createdAt: now },
          },
          upsert: true,
        },
      });
    }
  }
  for (let i = 0; i < ops.length; i += 1000) await Locality.bulkWrite(ops.slice(i, i + 1000), { ordered: false, timestamps: false });
  return { localities, roads };
}

/** `<repo>/scripts/seed-data` (this file lives in services/marketplace/{src,dist}/domain). */
export function defaultSeedDataDir(): string {
  return fileURLToPath(new URL('../../../../scripts/seed-data', import.meta.url));
}

const loads = new WeakMap<Connection, Promise<void>>();

/**
 * Lazy demo load: once per process and connection, if the collection is empty, read localities.json
 * and upsert it. Never throws (a missing/broken file → empty gazetteer).
 */
export function ensureGazetteer(conn: Connection, opts: { seedDataDir?: string; production: boolean; logger?: { warn: (o: object, m: string) => void } }): Promise<void> {
  if (opts.production) return Promise.resolve();
  let p = loads.get(conn);
  if (!p) {
    p = (async () => {
      try {
        if ((await localityModel(conn).estimatedDocumentCount()) > 0) return;
        const file = path.join(opts.seedDataDir || defaultSeedDataDir(), 'localities.json');
        const raw = await readFile(file, 'utf8').catch(() => null);
        if (!raw) return;
        const parsed = JSON.parse(raw) as unknown;
        const rows = Array.isArray(parsed) ? parsed : ((parsed as { localities?: unknown[] })?.localities ?? []);
        await upsertLocalities(conn, rows as LocalitySeedRow[]);
      } catch (err) {
        opts.logger?.warn({ err }, 'gazetteer lazy load failed');
      }
    })();
    loads.set(conn, p);
  }
  return p;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const KIND_RANK: Record<string, number> = { LOCALITY: 0, LANDMARK: 1, ROAD: 2 };
const sqDist = (a: LatLng, b: LatLng) => (a.lat - b.lat) ** 2 + ((a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180)) ** 2;
export const latLngOf = (l: LocalityLean): LatLng => ({ lat: l.location.coordinates[1]!, lng: l.location.coordinates[0]! });

/** Every query word must prefix-match a token (multikey index on `tokens`). */
export async function searchGazetteer(conn: Connection, q: string, opts: { bias?: LatLng; limit: number }): Promise<LocalityLean[]> {
  const words = tokenize(q).slice(0, 6);
  if (!words.length) return [];
  const rows = await localityModel(conn)
    .find({ $and: words.map((w) => ({ tokens: { $regex: `^${escapeRegex(w)}` } })) })
    .limit(300)
    .lean<LocalityLean[]>();
  const ql = q.trim().toLowerCase();
  const score = (l: LocalityLean) => (l.primary.toLowerCase().startsWith(ql) || l.name.toLowerCase().startsWith(ql) ? 0 : 1);
  return rows
    .sort(
      (a, b) =>
        score(a) - score(b) ||
        (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) ||
        (opts.bias ? sqDist(latLngOf(a), opts.bias) - sqDist(latLngOf(b), opts.bias) : 0) ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name),
    )
    .slice(0, opts.limit);
}

export async function gazetteerById(conn: Connection, id: string): Promise<LocalityLean | null> {
  if (!/^[a-f0-9]{24}$/i.test(id)) return null;
  return localityModel(conn).findById(id).lean<LocalityLean>();
}

/** Nearest LOCALITY within `maxKm` (default 3 km). */
export async function nearestLocality(conn: Connection, p: LatLng, maxKm = 3): Promise<LocalityLean | null> {
  return localityModel(conn)
    .findOne({ kind: 'LOCALITY', location: { $near: { $geometry: point(p.lat, p.lng), $maxDistance: maxKm * 1000 } } })
    .lean<LocalityLean>();
}
