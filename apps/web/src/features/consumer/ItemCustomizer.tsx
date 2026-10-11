/**
 * Item customizer (board 11, 11-15…11-19): dialog ≥640, full-height bottom sheet <640 (Dialog does both).
 *   required single choice → radio cards with ABSOLUTE prices (base + option, "Half · serves 1 ₹249") and a tag
 *     `REQUIRED · PICK 1` that turns `DONE`;
 *   optional single choice → radios + a "None" option (clearable);
 *   multi choice → checkboxes with "1 of 3", unselected options lock at the max; unavailable options disabled;
 *   quantity 1…20; CTA "Choose a size" until required groups are satisfied, then "Add to cart" + live total
 *   ((base + add-ons) × qty — display only; the server re-prices on POST /cart/items). Server error inline.
 */
import { useId, useMemo, useState, type ReactNode } from 'react';
import type { Selection } from '@thali/contracts';
import { Button, Dialog, Field, InlineError, Input, QtyStepper, VegMark } from '../../components/ui';
import { CheckGlyph } from '../../components/ui/Checkbox';
import { RadioGlyph } from '../../components/ui/Radio';
import { formatINR } from '../../lib/format';
import { cn } from '../../lib/cn';
import type { CustomizationGroup, MenuItem } from './api';

export interface CustomizerResult {
  selections: Selection[];
  quantity: number;
  note: string | undefined;
}

export interface ItemCustomizerProps {
  item: MenuItem;
  restaurantName?: string;
  open: boolean;
  onClose: () => void;
  onAdd: (result: CustomizerResult) => unknown | Promise<unknown>;
  /** Server error from the last add attempt (shown inline above the footer). */
  error?: unknown;
  busy?: boolean;
}

export function unmetGroups(item: MenuItem, chosen: Record<string, string[]>): CustomizationGroup[] {
  return item.customizationGroups.filter((g) => (chosen[g.id]?.length ?? 0) < g.minSelect);
}

/** "from ₹249": base + the cheapest available option of every required group (null when nothing is required). */
export function fromPricePaise(item: MenuItem): number | null {
  const required = item.customizationGroups.filter((g) => g.minSelect > 0);
  if (!required.length) return null;
  let p = item.pricePaise;
  for (const g of required) {
    const prices = g.options.filter((o) => o.available).map((o) => o.pricePaise).sort((a, b) => a - b);
    p += prices.slice(0, g.minSelect).reduce((s, x) => s + x, 0);
  }
  return p;
}

const rupees = (p: number) => formatINR(p).replace(/\.00$/, '');

function ChoiceRow({
  type, name, label, aside, checked, disabled, unavailable, onChange,
}: { type: 'radio' | 'checkbox'; name: string; label: ReactNode; aside?: ReactNode; checked: boolean; disabled?: boolean; unavailable?: boolean; onChange: () => void }) {
  const id = useId().replace(/:/g, '');
  return (
    <label
      htmlFor={`c${id}`}
      className={cn(
        'flex min-h-[52px] w-full cursor-pointer items-center gap-3 rounded-control border px-3.5 py-2 text-left text-[14.5px] transition-[border-color,background-color] duration-150',
        'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-acc',
        checked ? 'border-pri bg-acc-soft' : 'border-line bg-card hover:border-line-2',
        disabled && 'cursor-not-allowed opacity-45',
      )}
    >
      <span className="relative flex shrink-0">
        <input id={`c${id}`} type={type} name={name} checked={checked} disabled={disabled} onChange={onChange} className="peer absolute inset-0 size-[18px] cursor-[inherit] appearance-none opacity-0" />
        {type === 'radio' ? <RadioGlyph /> : <CheckGlyph />}
      </span>
      <span className="min-w-0 flex-1 text-fg">
        {label}
        {unavailable ? <span className="text-fg-3"> · Unavailable</span> : null}
      </span>
      {aside ? <span className="shrink-0 text-fg-3 tabular-nums">{aside}</span> : null}
    </label>
  );
}

function ctaFor(g: CustomizationGroup): string {
  const n = g.name.trim().toLowerCase();
  if (g.minSelect === 1 && /size|portion/.test(n)) return 'Choose a size';
  return g.minSelect === 1 ? `Choose ${n}` : `Choose ${g.minSelect} in ${n}`;
}

export function ItemCustomizer({ item, restaurantName, open, onClose, onAdd, error, busy }: ItemCustomizerProps) {
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');
  const baseId = useId().replace(/:/g, '');

  const unitPaise = useMemo(() => {
    let p = item.pricePaise;
    for (const g of item.customizationGroups) for (const id of chosen[g.id] ?? []) p += g.options.find((o) => o.id === id)?.pricePaise ?? 0;
    return p;
  }, [chosen, item]);
  const unmet = unmetGroups(item, chosen);
  const totalPaise = unitPaise * quantity;

  const setSingle = (g: CustomizationGroup, optionId: string | null) => setChosen((prev) => ({ ...prev, [g.id]: optionId ? [optionId] : [] }));
  const toggleMulti = (g: CustomizationGroup, optionId: string) =>
    setChosen((prev) => {
      const cur = prev[g.id] ?? [];
      if (cur.includes(optionId)) return { ...prev, [g.id]: cur.filter((x) => x !== optionId) };
      if (cur.length >= g.maxSelect) return prev;
      return { ...prev, [g.id]: [...cur, optionId] };
    });

  const submit = () => {
    if (unmet.length) return;
    const selections: Selection[] = item.customizationGroups
      .filter((g) => (chosen[g.id]?.length ?? 0) > 0)
      .map((g) => ({ groupId: g.id, optionIds: [...chosen[g.id]!] }));
    void onAdd({ selections, quantity, note: note.trim() || undefined });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={item.name}
      size="md"
      footer={
        <div className="flex w-full flex-col gap-2.5">
          <InlineError error={error} />
          {unmet.length ? (
            <p className="sr-only" id={`${baseId}-why`}>
              Choose {unmet[0]!.minSelect} option{unmet[0]!.minSelect > 1 ? 's' : ''} in {unmet[0]!.name} to continue.
            </p>
          ) : null}
          <div className="flex items-center gap-3">
            <QtyStepper size="lg" value={quantity} min={1} max={20} itemName={item.name} onChange={setQuantity} />
            <Button
              size="lg"
              className={cn('h-[46px] flex-1 justify-between px-5', unmet.length > 0 && 'disabled:opacity-40')}
              onClick={submit}
              disabled={unmet.length > 0}
              loading={busy}
              aria-describedby={unmet.length ? `${baseId}-why` : undefined}
              aria-label={unmet.length ? `${ctaFor(unmet[0]!)} to add to cart` : `Add to cart, ${formatINR(totalPaise)}`}
            >
              <span>{unmet.length ? ctaFor(unmet[0]!) : 'Add to cart'}</span>
              <span className="tabular-nums">{rupees(totalPaise)}</span>
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-[22px]">
        <p className="-mt-2 flex items-center gap-2 text-[13px] text-fg-3">
          <VegMark veg={item.isVeg} size={13} />
          {restaurantName ?? (item.isVeg ? 'Veg' : 'Non-veg')}
          {item.description ? <span className="sr-only">. {item.description}</span> : null}
        </p>
        {item.customizationGroups.map((g) => {
          const cur = chosen[g.id] ?? [];
          const single = g.maxSelect === 1;
          const required = g.minSelect > 0;
          const done = cur.length >= g.minSelect;
          const atMax = !single && cur.length >= g.maxSelect;
          const name = `${baseId}-${g.id}`;
          return (
            <fieldset key={g.id} className="flex flex-col gap-2">
              <legend className="mb-2 flex w-full items-center justify-between gap-2">
                <span className="text-[15px] font-semibold text-fg">{g.name}</span>
                {required ? (
                  <span className={cn('rounded-pill px-2 py-1 font-mono text-[11.5px] font-medium', done ? 'bg-ok-bg text-ok' : 'bg-warn-bg text-warn')}>
                    {done ? 'DONE' : `REQUIRED · PICK ${g.minSelect === g.maxSelect ? g.minSelect : `${g.minSelect}–${g.maxSelect}`}`}
                  </span>
                ) : (
                  <span className="text-[13px] text-fg-3">{single ? 'Optional' : `${cur.length} of ${g.maxSelect}`}</span>
                )}
              </legend>
              {single && !required ? (
                <ChoiceRow type="radio" name={name} label="None" checked={cur.length === 0} onChange={() => setSingle(g, null)} />
              ) : null}
              {g.options.map((o) => {
                const checked = cur.includes(o.id);
                const lockedByMax = atMax && !checked;
                const aside = single && required ? rupees(item.pricePaise + o.pricePaise) : o.pricePaise > 0 ? `+${rupees(o.pricePaise)}` : undefined;
                return (
                  <ChoiceRow
                    key={o.id}
                    type={single ? 'radio' : 'checkbox'}
                    name={name}
                    label={o.name}
                    aside={aside}
                    checked={checked}
                    disabled={!o.available || lockedByMax}
                    unavailable={!o.available}
                    onChange={() => (single ? setSingle(g, o.id) : toggleMulti(g, o.id))}
                  />
                );
              })}
              {atMax ? <p className="px-1 text-xs text-fg-3">Maximum {g.maxSelect} selected</p> : null}
            </fieldset>
          );
        })}
        <Field label="Cooking note" optional hint="E.g. less spicy. The restaurant will try to follow it.">
          <Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
