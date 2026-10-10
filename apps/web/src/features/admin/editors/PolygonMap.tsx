/** Leaflet part of the service-area editor (lazy-loaded). Exposes the live map centre for the keyboard path. */
import { useEffect, type MutableRefObject } from 'react';
import { useMap } from 'react-leaflet';
import type { GeoPoint } from '@thali/contracts';
import { MapView } from '../../../components/ui/Map';

export type CenterGetter = () => GeoPoint;

function CenterExposer({ centerRef }: { centerRef: MutableRefObject<CenterGetter | null> }) {
  const map = useMap();
  useEffect(() => {
    centerRef.current = () => {
      const c = map.getCenter();
      return { lat: c.lat, lng: c.lng };
    };
    return () => {
      centerRef.current = null;
    };
  }, [map, centerRef]);
  return null;
}

export default function PolygonMap({ points, center, onAdd, centerRef }: { points: GeoPoint[]; center: GeoPoint; onAdd: (p: GeoPoint) => void; centerRef: MutableRefObject<CenterGetter | null> }) {
  return (
    <MapView
      center={center}
      zoom={12}
      followCenter={false}
      fitToMarkers={false}
      ariaLabel="Service area map. Click to add polygon corners."
      className="h-72"
      polygons={points.length >= 2 ? [{ id: 'area', points, tone: 'brand', open: points.length < 3 }] : []}
      markers={points.map((p, i) => ({ id: `v${i}`, position: p, kind: 'point' as const, label: `Corner ${i + 1}` }))}
      onPick={onAdd}
    >
      <CenterExposer centerRef={centerRef} />
    </MapView>
  );
}
