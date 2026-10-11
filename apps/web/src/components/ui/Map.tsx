/**
 * Map wrapper (react-leaflet + OpenStreetMap tiles). Not in the ui barrel: import from './components/ui/Map'
 * so Leaflet (~150 KB) is only bundled into routes that show a map (lazy-load the page that uses it).
 *
 *   <MapView center={drop} markers={[
 *       { id: 'r', position: restaurant, kind: 'restaurant', label: 'Biryani House' },
 *       { id: 'p', position: partner, kind: 'partner', label: 'Arjun (your partner)' },
 *       { id: 'h', position: drop, kind: 'home', label: 'Delivery address' }]} />
 *
 *   // Pick a location: click/tap the map, or use the "Pin map centre" button (keyboard alternative)
 *   <MapView center={pin ?? DEFAULT_CENTER} picked={pin} onPick={setPin} ariaLabel="Choose delivery location" />
 *
 *   // Polygons (service areas) and extra layers:
 *   <MapView center={c} polygons={[{ id: 'a', points, tone: 'brand' }]} onPick={addVertex} />
 *
 * Markers are DivIcons (inline SVG), so no image assets are needed. Arrow keys pan and +/- zoom when the
 * map is focused (Leaflet keyboard support).
 */
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect, useMemo, type ReactNode } from 'react';
import { MapContainer, Marker, Polygon, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import type { GeoPoint } from '@thali/contracts';
import { cn } from '../../lib/cn';
import { DEFAULT_CENTER } from '../../lib/geo';
import { Button } from './Button';

export const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export type MarkerKind = 'restaurant' | 'home' | 'partner' | 'pin' | 'point';

export interface MapMarker {
  id: string;
  position: GeoPoint;
  kind?: MarkerKind;
  /** Tooltip text and accessible name. */
  label?: string;
}

export interface MapPolygon {
  id: string;
  points: GeoPoint[];
  tone?: 'brand' | 'info' | 'danger';
  /** Draw as an open line instead of a filled polygon (e.g. while editing). */
  open?: boolean;
}

const KIND_STYLE: Record<MarkerKind, { color: string; glyph: string }> = {
  restaurant: { color: '#c2410c', glyph: '<path d="M8 6v5a2 2 0 0 0 4 0V6M10 6v12M15 6c-1 0-2 1.5-2 4s1 3 2 3v5" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/>' },
  home: { color: '#15803d', glyph: '<path d="m7 12 5-4.5 5 4.5M8.5 11v6h7v-6" stroke="#fff" stroke-width="1.6" fill="none" stroke-linejoin="round"/>' },
  partner: { color: '#1d4ed8', glyph: '<circle cx="9" cy="15" r="2.2" stroke="#fff" stroke-width="1.5" fill="none"/><circle cx="16" cy="15" r="2.2" stroke="#fff" stroke-width="1.5" fill="none"/><path d="M9 15l2-4h3l2 4M12 11l-1-2" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round"/>' },
  pin: { color: '#e8590c', glyph: '<circle cx="12" cy="11" r="3" fill="#fff"/>' },
  point: { color: '#475569', glyph: '<circle cx="12" cy="11" r="2.5" fill="#fff"/>' },
};

const iconCache = new Map<MarkerKind, L.DivIcon>();
/** DivIcon for a marker kind (cached). Useful with raw react-leaflet <Marker> children. */
export function markerIcon(kind: MarkerKind = 'pin'): L.DivIcon {
  let icon = iconCache.get(kind);
  if (!icon) {
    const { color, glyph } = KIND_STYLE[kind];
    icon = L.divIcon({
      className: 'thali-marker',
      iconSize: [32, 40],
      iconAnchor: [16, 38],
      tooltipAnchor: [0, -34],
      html: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 24 30" aria-hidden="true"><path d="M12 29s9-8.2 9-16A9 9 0 0 0 3 13c0 7.8 9 16 9 16Z" fill="${color}" stroke="#fff" stroke-width="1.5"/>${glyph}</svg>`,
    });
    iconCache.set(kind, icon);
  }
  return icon;
}

const polyColor = { brand: '#e8590c', info: '#1d4ed8', danger: '#b91c1c' };

function PickHandler({ onPick }: { onPick: (p: GeoPoint) => void }) {
  useMapEvents({ click: (e) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}

function Recenter({ center, zoom }: { center: GeoPoint; zoom?: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([center.lat, center.lng], zoom ?? map.getZoom(), { animate: true });
  }, [map, center.lat, center.lng, zoom]);
  return null;
}

function FitBounds({ points }: { points: GeoPoint[] }) {
  const map = useMap();
  const key = points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|');
  useEffect(() => {
    if (points.length < 2) return;
    map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])), { padding: [36, 36], maxZoom: 16 });
    // Keyed on the serialized positions: `points` is a new array every render, refit only when they move.
  }, [map, key]);
  return null;
}

function CenterPinButton({ onPick }: { onPick: (p: GeoPoint) => void }) {
  const map = useMap();
  return (
    <div className="leaflet-bottom leaflet-left">
      <div className="leaflet-control m-3!">
        <Button
          size="sm"
          variant="secondary"
          icon="crosshair"
          onClick={(e) => {
            e.stopPropagation();
            const c = map.getCenter();
            onPick({ lat: c.lat, lng: c.lng });
          }}
        >
          Pin map centre
        </Button>
      </div>
    </div>
  );
}

export interface MapViewProps {
  center?: GeoPoint;
  zoom?: number;
  markers?: MapMarker[];
  /** The user's picked point (rendered as a 'pin' marker). */
  picked?: GeoPoint | null;
  onPick?: (p: GeoPoint) => void;
  polygons?: MapPolygon[];
  /** Fit the view to all markers when there are 2+ (default true). Disable when the user pans manually. */
  fitToMarkers?: boolean;
  /** Keep the view centred on `center` when it changes (default true). */
  followCenter?: boolean;
  ariaLabel?: string;
  className?: string;
  children?: ReactNode;
}

export function MapView({
  center = DEFAULT_CENTER, zoom = 14, markers = [], picked, onPick, polygons = [], fitToMarkers = true, followCenter = true,
  ariaLabel = 'Map', className, children,
}: MapViewProps) {
  const all = useMemo<MapMarker[]>(
    () => (picked ? [...markers, { id: '__picked', position: picked, kind: 'pin', label: 'Selected location' }] : markers),
    [markers, picked],
  );
  return (
    <div role="region" aria-label={ariaLabel} className={cn('relative isolate overflow-hidden rounded-card border border-line', className ?? 'h-72')}>
      <MapContainer center={[center.lat, center.lng]} zoom={zoom} scrollWheelZoom={false} className="h-full w-full" keyboard>
        <TileLayer url={OSM_TILE_URL} attribution={OSM_ATTRIBUTION} maxZoom={19} />
        {followCenter ? <Recenter center={center} /> : null}
        {fitToMarkers ? <FitBounds points={markers.map((m) => m.position)} /> : null}
        {onPick ? <PickHandler onPick={onPick} /> : null}
        {onPick ? <CenterPinButton onPick={onPick} /> : null}
        {polygons.map((p) =>
          p.open ? (
            <Polyline key={p.id} positions={p.points.map((pt) => [pt.lat, pt.lng] as [number, number])} pathOptions={{ color: polyColor[p.tone ?? 'brand'], weight: 3, dashArray: '6 6' }} />
          ) : (
            <Polygon key={p.id} positions={p.points.map((pt) => [pt.lat, pt.lng] as [number, number])} pathOptions={{ color: polyColor[p.tone ?? 'brand'], weight: 2, fillOpacity: 0.12 }} />
          ),
        )}
        {all.map((m) => (
          <Marker key={m.id} position={[m.position.lat, m.position.lng]} icon={markerIcon(m.kind)} title={m.label} alt={m.label} keyboard={Boolean(m.label)}>
            {m.label ? <Tooltip>{m.label}</Tooltip> : null}
          </Marker>
        ))}
        {children}
      </MapContainer>
    </div>
  );
}

export { MapView as Map };
