/**
 * Address search, place lookup and reverse geocoding (MKT-1, gap-analysis §2.1). Public endpoints; demo
 * results are labelled `source: 'DEMO_GAZETTEER'` (honest-data rule — show it).
 *
 *   const { items } = await searchPlaces('indiranagar', { lat, lng });   // q: 2–100 chars
 *   const place = await getPlace(items[0].id);                           // has location + serviceable
 *   const here = await reverseGeocode({ lat, lng });                      // label + serviceable
 */
import type { GeoPoint } from '@thali/contracts';
import { api } from './api';

export type PlaceSource = 'GOOGLE' | 'DEMO_GAZETTEER' | 'FALLBACK' | (string & {});

export interface PlaceSuggestion {
  id: string;
  primary: string;
  secondary?: string | null;
  locality?: string | null;
  city?: string | null;
  pincode?: string | null;
  /** May be null for Google results (resolved by getPlace). */
  location?: GeoPoint | null;
  source: PlaceSource;
}

export interface ServiceAreaRef {
  id: string;
  name: string;
  minOrderPaise?: number;
}

export interface PlaceDetails {
  id: string;
  formattedAddress: string;
  locality?: string | null;
  city?: string | null;
  pincode?: string | null;
  location: GeoPoint;
  serviceable: boolean;
  serviceArea: ServiceAreaRef | null;
  source: PlaceSource;
}

export interface ReverseResult {
  label: string;
  locality?: string | null;
  city?: string | null;
  pincode?: string | null;
  serviceable: boolean;
  serviceArea: ServiceAreaRef | null;
  source: PlaceSource;
}

export const PLACES_MIN_QUERY = 2;

export function searchPlaces(q: string, bias?: GeoPoint | null, signal?: AbortSignal) {
  return api<{ items: PlaceSuggestion[]; source?: PlaceSource }>('/discovery/places', {
    auth: false,
    signal,
    query: { q: q.trim().slice(0, 100), lat: bias?.lat, lng: bias?.lng, limit: 8 },
  });
}

export function getPlace(placeId: string) {
  return api<PlaceDetails>(`/discovery/places/${encodeURIComponent(placeId)}`, { auth: false });
}

export function reverseGeocode(p: GeoPoint) {
  return api<ReverseResult>('/discovery/reverse', { auth: false, query: { lat: p.lat, lng: p.lng } });
}

/** Short chip label from a reverse label ("12th Main Rd, Indiranagar" → "12th Main Rd"). */
export function shortLabel(label: string): string {
  const first = label.split(',')[0]?.trim();
  return first || label;
}
