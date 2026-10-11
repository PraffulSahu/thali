/**
 * Input data for the Bengaluru seed generator: the JSON files in `scripts/seed-data` (see its README) and
 * the image-mirror manifest written by `scripts/seed-images.ts`. Node only (reads files).
 *
 * Locations: `SEED_DATA_DIR` (default `<repo>/scripts/seed-data`) and `SEED_IMAGE_MANIFEST` (default
 * `<repo>/.cache/seed-images/manifest.json`). In docker mode `scripts/seed.ts` copies both into the service
 * container and sets the env vars.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface LocalityRow {
  name: string;
  pincode: string;
  lat: number;
  lng: number;
  zone: 'central' | 'north' | 'south' | 'east' | 'west';
  streets: string[];
}
export interface CuisineRow {
  slug: string;
  name: string;
  imageId: string;
  weight: number;
}
export interface DishVariantOption {
  name: string;
  priceDeltaPaise: number;
  default?: boolean;
}
export interface DishAddonGroup {
  name: string;
  min: number;
  max: number;
  options: { name: string; pricePaise: number }[];
}
export interface DishRow {
  id: string;
  cuisine: string;
  name: string;
  description: string;
  isVeg: boolean;
  basePricePaise: number;
  menuSection: string;
  tags: string[];
  variants?: { name: string; options: DishVariantOption[] };
  addonGroups?: DishAddonGroup[];
  imageIds: string[];
}
export type RestaurantType = 'darshini' | 'tiffin-room' | 'military-hotel' | 'cloud-kitchen' | 'family-restaurant' | 'quick-service' | 'cafe';
export interface RestaurantNameRow {
  name: string;
  type: RestaurantType;
  veg: 'pure-veg' | 'non-veg' | 'veg-and-non-veg';
  priceBand: 'budget' | 'mid' | 'premium';
  description: string;
  secondaryCuisines: string[];
}
export interface PersonRow {
  firstName: string;
  lastName: string;
  fullName: string;
  gender: 'male' | 'female';
  community: string;
}
export interface AvatarRow {
  id: string;
  gender: 'male' | 'female';
  url: string;
  thumbUrl: string;
}
export interface ImageRow {
  id: string;
  kind: 'dish' | 'cuisine' | 'restaurant-cover' | 'hero';
  subject: string;
  title: string;
  url: string;
  thumbUrl: string;
  tags: string[];
}

export interface BlrData {
  localities: LocalityRow[];
  cuisines: CuisineRow[];
  dishes: DishRow[];
  restaurantNames: Record<string, RestaurantNameRow[]>;
  people: PersonRow[];
  avatars: AvatarRow[];
  images: ImageRow[];
}

/** Ids mirrored into the public bucket (`scripts/seed-images.ts`); anything else stays an absolute URL. */
export interface ImageManifest {
  pool: Record<string, string>;
  avatars: Record<string, string>;
}
export const EMPTY_MANIFEST: ImageManifest = { pool: {}, avatars: {} };

/** `<repo>/scripts/seed-data` (this file lives in packages/contracts/{src,dist}). */
export function defaultSeedDataDir(): string {
  return fileURLToPath(new URL('../../../scripts/seed-data', import.meta.url));
}
export function defaultImageManifestPath(): string {
  return fileURLToPath(new URL('../../../.cache/seed-images/manifest.json', import.meta.url));
}

const readJson = <T>(dir: string, file: string): T => JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as T;

export function loadBlrData(dir: string = process.env.SEED_DATA_DIR || defaultSeedDataDir()): BlrData {
  if (!existsSync(`${dir}/localities.json`)) {
    throw new Error(`Bengaluru seed data not found in ${dir} (set SEED_DATA_DIR to the scripts/seed-data directory)`);
  }
  return {
    localities: readJson(dir, 'localities.json'),
    cuisines: readJson(dir, 'cuisines.json'),
    dishes: readJson(dir, 'dishes.json'),
    restaurantNames: readJson<{ cuisines: Record<string, RestaurantNameRow[]> }>(dir, 'restaurant-names.json').cuisines,
    people: readJson(dir, 'people.json'),
    avatars: readJson(dir, 'avatars.json'),
    images: readJson(dir, 'images.json'),
  };
}

/** Missing or unreadable manifest → nothing mirrored (every photo is an absolute URL). */
export function loadImageManifest(path: string = process.env.SEED_IMAGE_MANIFEST || defaultImageManifestPath()): ImageManifest {
  try {
    if (!existsSync(path)) return EMPTY_MANIFEST;
    const m = JSON.parse(readFileSync(path, 'utf8')) as Partial<ImageManifest>;
    return { pool: m.pool ?? {}, avatars: m.avatars ?? {} };
  } catch {
    return EMPTY_MANIFEST;
  }
}

/** Image ref for a document: the mirrored bucket key, else the absolute URL (allowlisted host), else null. */
export function imageRef(data: BlrData, manifest: ImageManifest, imageId: string): string | null {
  const key = manifest.pool[imageId];
  if (key) return key;
  return imageById(data).get(imageId)?.url ?? null;
}
export function avatarRef(manifest: ImageManifest, avatar: AvatarRow): string {
  return manifest.avatars[avatar.id] ?? avatar.url;
}

const byId = new WeakMap<BlrData, Map<string, ImageRow>>();
export function imageById(data: BlrData): Map<string, ImageRow> {
  let m = byId.get(data);
  if (!m) {
    m = new Map(data.images.map((i) => [i.id, i]));
    byId.set(data, m);
  }
  return m;
}
