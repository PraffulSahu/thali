/**
 * Quantity stepper (design-spec §3.22 `.qty`): − count + in a pill. `size="lg"` for the customizer,
 * `tone="primary"` for the in-cart dish button.
 *
 *   <QtyStepper value={line.qty} onChange={(q) => update(line.id, q)} itemName="Chicken Dum Biryani" />
 *   // q = 0 means "remove"; pass min={1} to block it
 */
import { cn } from '../../lib/cn';
import { Icon } from './Icon';

export interface QtyStepperProps {
  value: number;
  onChange: (next: number) => void;
  /** Used in the button names: "Remove one Chicken Dum Biryani". */
  itemName: string;
  min?: number;
  max?: number;
  size?: 'md' | 'lg';
  tone?: 'default' | 'primary';
  disabled?: boolean;
  className?: string;
}

export function QtyStepper({ value, onChange, itemName, min = 0, max = 99, size = 'md', tone = 'default', disabled, className }: QtyStepperProps) {
  const lg = size === 'lg';
  const btn = cn(
    'grid place-items-center rounded-pill font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45 [@media(pointer:coarse)]:min-w-touch',
    lg ? 'h-11 w-[42px] text-lg' : 'size-[30px] text-base',
    tone === 'primary' ? 'hover:bg-white/15' : 'hover:bg-fill',
  );
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-pill border',
        lg ? 'h-[46px] bg-card' : 'h-8',
        tone === 'primary' ? 'border-pri bg-pri text-pri-fg' : 'border-line text-fg',
        className,
      )}
    >
      <button type="button" className={btn} onClick={() => onChange(value - 1)} disabled={disabled || value <= min} aria-label={value === 1 && min === 0 ? `Remove ${itemName}` : `Remove one ${itemName}`}>
        <Icon name="minus" size={lg ? 16 : 14} />
      </button>
      <span aria-live="polite" className={cn('min-w-3.5 text-center tabular-nums', lg ? 'text-[15px] font-semibold' : 'text-[13px]')}>
        <span className="sr-only">{itemName} quantity </span>
        {value}
      </span>
      <button type="button" className={btn} onClick={() => onChange(value + 1)} disabled={disabled || value >= max} aria-label={`Add one ${itemName}`}>
        <Icon name="plus" size={lg ? 16 : 14} />
      </button>
    </div>
  );
}
