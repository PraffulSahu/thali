/**
 * Address cards (design-spec §3.24). Selection cards are radio inputs (use a shared `name`).
 *
 *   <div className="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-2.5" role="radiogroup" aria-label="Deliver to">
 *     {addresses.map((a) => (
 *       <AddressCard key={a.id} name="address" label={a.label} address={a.line} isDefault={a.isDefault}
 *         checked={selected === a.id} onSelect={() => setSelected(a.id)}
 *         disabledReason={a.serviceable ? undefined : 'Outside delivery area'} />))}
 *     <AddAddressCard onClick={openForm} />
 *   </div>
 */
import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { RadioGlyph } from './Radio';
import { Icon } from './Icon';

export interface AddressCardProps {
  name: string;
  label: ReactNode;
  address: ReactNode;
  isDefault?: boolean;
  checked: boolean;
  onSelect: () => void;
  /** Disables the card and shows the reason in --bad (e.g. "Outside delivery area"). */
  disabledReason?: string;
  /** Extra actions under the card (Edit / Set default / Delete). Rendered outside the label. */
  actions?: ReactNode;
  value?: string;
  className?: string;
}

export function AddressCard({ name, label, address, isDefault, checked, onSelect, disabledReason, actions, value, className }: AddressCardProps) {
  const id = useId().replace(/:/g, '');
  const disabled = Boolean(disabledReason);
  return (
    <div className={cn('flex flex-col', className)}>
      <label
        htmlFor={`addr${id}`}
        className={cn(
          'flex cursor-pointer items-start gap-3 rounded-field border px-4 py-3.5 text-left transition-[border-color,background-color] duration-150',
          'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-acc',
          checked ? 'border-pri bg-acc-soft' : 'border-line bg-card hover:border-line-2',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <span className="relative mt-0.5 flex">
          <input
            id={`addr${id}`}
            type="radio"
            name={name}
            value={value}
            checked={checked}
            disabled={disabled}
            onChange={onSelect}
            aria-describedby={disabledReason ? `addr${id}-why` : undefined}
            className="peer absolute inset-0 size-[18px] cursor-[inherit] appearance-none opacity-0"
          />
          <RadioGlyph />
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-2 text-[14.5px] font-semibold text-fg">
            {label}
            {isDefault ? <span className="rounded-tag bg-fill px-1.5 py-0.5 font-mono text-[10px] font-normal text-fg-3">DEFAULT</span> : null}
          </span>
          <span className="text-[13px] leading-[1.45] text-fg-3">{address}</span>
          {disabledReason ? (
            <span id={`addr${id}-why`} className="text-[13px] text-bad">
              {disabledReason}
            </span>
          ) : null}
        </span>
      </label>
      {actions ? <div className="mt-1 flex flex-wrap gap-1">{actions}</div> : null}
    </div>
  );
}

export function AddAddressCard({ onClick, label = 'Add new address', className }: { onClick: () => void; label?: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-h-[76px] items-center justify-center gap-2 rounded-field border border-dashed border-line-2 bg-card px-4 py-3.5 text-[14.5px] font-medium text-fg-2 transition-colors duration-150 hover:border-fg-3 hover:text-fg',
        className,
      )}
    >
      <Icon name="plus" size={16} />
      {label}
    </button>
  );
}
