/**
 * Veg / non-veg mark (design-spec §3.10) and the "Pure veg" badge (§3.20).
 *
 *   <VegMark veg />                 // 14px, role="img" aria-label="Veg"
 *   <VegMark veg={false} size={13} />
 *   <VegMark veg withLabel />       // mark + "Veg" text (600 14px)
 *   <VegMark veg onColor />         // white mark on a pressed chili pill
 *   <PureVegBadge />                // card badge: 24px pill on --card, --veg text
 */
import { cn } from '../../lib/cn';
import { FoodMarker } from './Icon';

export interface VegMarkProps {
  veg: boolean;
  /** 12 card badge · 13 lists · 14 dish rows (default) · 16 foundations */
  size?: number;
  withLabel?: boolean;
  onColor?: boolean;
  className?: string;
}

export function VegMark({ veg, size = 14, withLabel, onColor, className }: VegMarkProps) {
  if (!withLabel) return <FoodMarker veg={veg} size={size} onColor={onColor} className={className} />;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm font-semibold text-fg', className)}>
      <FoodMarker veg={veg} size={size} onColor={onColor} />
      <span aria-hidden="true">{veg ? 'Veg' : 'Non-veg'}</span>
    </span>
  );
}

export function PureVegBadge({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-pill border border-line bg-card px-[9px] text-xs font-medium text-veg', className)}>
      <span aria-hidden="true" className="contents"><FoodMarker veg size={12} /></span>
      <span aria-hidden="true">Pure veg</span>
      <span className="sr-only">Pure veg restaurant</span>
    </span>
  );
}
