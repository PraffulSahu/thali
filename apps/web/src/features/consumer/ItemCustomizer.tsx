/**
 * Item customization dialog (PRD C-4). Enforces each group's minSelect/maxSelect and option availability on
 * the client for fast feedback; the server re-validates at add and at checkout (INVALID_SELECTION).
 * Single-choice groups (maxSelect 1) are radios; others are checkboxes that lock once the max is reached.
 */
import { useId, useMemo, useState } from 'react';
import type { Selection } from '@thali/contracts';
import { Button, Dialog, Field, FoodMarker, IconButton, InlineError, Input, Price } from '../../components/ui';
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
  open: boolean;
  onClose: () => void;
  onAdd: (result: CustomizerResult) => unknown | Promise<unknown>;
  /** Server error from the last add attempt (shown inline). */
  error?: unknown;
  busy?: boolean;
}

function groupRule(g: CustomizationGroup): string {
  if (g.minSelect === 0) return g.maxSelect === 1 ? 'Optional · choose up to 1' : `Optional · choose up to ${g.maxSelect}`;
  if (g.minSelect === g.maxSelect) return `Required · choose ${g.minSelect}`;
  return `Required · choose ${g.minSelect}–${g.maxSelect}`;
}

export function unmetGroups(item: MenuItem, chosen: Record<string, string[]>): CustomizationGroup[] {
  return item.customizationGroups.filter((g) => (chosen[g.id]?.length ?? 0) < g.minSelect);
}

export function ItemCustomizer({ item, open, onClose, onAdd, error, busy }: ItemCustomizerProps) {
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');
  const baseId = useId();

  const unitPaise = useMemo(() => {
    let p = item.pricePaise;
    for (const g of item.customizationGroups) {
      for (const id of chosen[g.id] ?? []) p += g.options.find((o) => o.id === id)?.pricePaise ?? 0;
    }
    return p;
  }, [chosen, item]);
  const unmet = unmetGroups(item, chosen);
  const totalPaise = unitPaise * quantity;

  const toggle = (g: CustomizationGroup, optionId: string) => {
    setChosen((prev) => {
      const cur = prev[g.id] ?? [];
      if (g.maxSelect === 1) return { ...prev, [g.id]: [optionId] };
      if (cur.includes(optionId)) return { ...prev, [g.id]: cur.filter((x) => x !== optionId) };
      if (cur.length >= g.maxSelect) return prev;
      return { ...prev, [g.id]: [...cur, optionId] };
    });
  };

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
      title={
        <span className="flex items-center gap-2">
          <FoodMarker veg={item.isVeg} /> {item.name}
        </span>
      }
      description={item.description || undefined}
      size="md"
      footer={
        <div className="w-full space-y-2">
          <InlineError error={error} />
          {unmet.length ? (
            <p className="text-sm text-slate-600" id={`${baseId}-why`}>
              Choose {unmet[0]!.minSelect} option{unmet[0]!.minSelect > 1 ? 's' : ''} in {unmet[0]!.name} to continue.
            </p>
          ) : null}
          <div className="flex items-center gap-3">
            <div className="flex items-center rounded-control border border-slate-300" role="group" aria-label="Quantity">
              <IconButton icon="minus" label="Decrease quantity" size="sm" disabled={quantity <= 1} onClick={() => setQuantity((q) => Math.max(1, q - 1))} />
              <span className="w-8 text-center font-semibold tabular-nums" aria-live="polite">
                {quantity}
              </span>
              <IconButton icon="plus" label="Increase quantity" size="sm" disabled={quantity >= 20} onClick={() => setQuantity((q) => Math.min(20, q + 1))} />
            </div>
            <Button
              className="flex-1"
              onClick={submit}
              disabled={unmet.length > 0}
              loading={busy}
              aria-describedby={unmet.length ? `${baseId}-why` : undefined}
            >
              Add to cart · {formatINR(totalPaise)}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <p className="text-sm text-slate-600">
          Base price <Price paise={item.pricePaise} size="sm" />
        </p>
        {item.customizationGroups.map((g) => {
          const cur = chosen[g.id] ?? [];
          const single = g.maxSelect === 1;
          const atMax = !single && cur.length >= g.maxSelect;
          return (
            <fieldset key={g.id} className="space-y-1">
              <legend className="flex w-full items-baseline justify-between gap-2">
                <span className="font-semibold text-slate-900">{g.name}</span>
                <span className={cn('text-xs', g.minSelect > 0 && cur.length < g.minSelect ? 'font-semibold text-brand-700' : 'text-slate-600')}>
                  {groupRule(g)}
                </span>
              </legend>
              {g.options.map((o) => {
                const checked = cur.includes(o.id);
                const disabled = !o.available || (atMax && !checked);
                const inputId = `${baseId}-${g.id}-${o.id}`;
                return (
                  <label
                    key={o.id}
                    htmlFor={inputId}
                    className={cn(
                      'flex min-h-touch cursor-pointer items-center gap-3 rounded-control px-2',
                      disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-slate-50',
                    )}
                  >
                    <input
                      id={inputId}
                      type={single ? 'radio' : 'checkbox'}
                      name={`${baseId}-${g.id}`}
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggle(g, o.id)}
                      className="size-5 accent-brand-600"
                    />
                    <FoodMarker veg={o.isVeg} size={12} />
                    <span className="flex-1 text-slate-900">
                      {o.name}
                      {!o.available ? <span className="ml-2 text-xs text-slate-600">(unavailable)</span> : null}
                    </span>
                    {o.pricePaise > 0 ? <span className="text-sm tabular-nums text-slate-700">+{formatINR(o.pricePaise)}</span> : null}
                  </label>
                );
              })}
              {atMax ? <p className="px-2 text-xs text-slate-600">Maximum {g.maxSelect} selected</p> : null}
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
