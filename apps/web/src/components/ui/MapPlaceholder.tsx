/**
 * Map placeholder + SIMULATED LOCATION tag (design-spec §3.29). Use the placeholder while there are no
 * coordinates or when tiles fail; the real Leaflet <MapView> goes in the same frame (`<MapFrame>`).
 *
 *   <MapFrame simulated={tracking.simulated} ariaLabel="Map showing the rider between Spice Route and your home. Location is simulated.">
 *     {coords ? <MapView … className="h-full" /> : <MapPlaceholder />}
 *   </MapFrame>
 *   <SimulatedTag />            // standalone tag
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { MapRouteArt } from '../illustrations';

export function SimulatedTag({ className, children = 'SIMULATED LOCATION' }: { className?: string; children?: ReactNode }) {
  return (
    <span className={cn('inline-flex rounded-badge bg-pri px-[9px] py-1.5 font-mono text-[11px] leading-none tracking-[.06em] text-pri-fg', className)}>
      {children}
    </span>
  );
}

export interface MapFrameProps {
  children?: ReactNode;
  /** Show the SIMULATED LOCATION tag — only when the payload says so (honest-data rule). */
  simulated?: boolean;
  /** Sentence describing the map for screen readers. */
  ariaLabel: string;
  className?: string;
}

/** 280px (220px on phones) framed map area with top/bottom hairlines. */
export function MapFrame({ children, simulated, ariaLabel, className }: MapFrameProps) {
  return (
    <div role="img" aria-label={ariaLabel} className={cn('relative h-[280px] overflow-hidden border-y border-line bg-map max-sm:h-[220px]', className)}>
      {children ?? <MapPlaceholder />}
      {simulated ? <SimulatedTag className="absolute left-3.5 top-3.5 z-[400]" /> : null}
    </div>
  );
}

export function MapPlaceholder({ animate = true, className }: { animate?: boolean; className?: string }) {
  return <MapRouteArt animate={animate} className={cn('absolute inset-0 size-full', className)} />;
}
