/**
 * Customization groups and options editor for a menu item (PRD R-3: customizations and add-ons).
 * A group is a choice the customer makes: "Size" (min 1, max 1) or "Add-ons" (min 0, max 3). The same rules the
 * API enforces are checked live: minimum <= maximum <= number of options.
 */
import { Button, Checkbox, Field, Input } from '../../components/ui';
import { paiseToRupees, rupeesToPaise, type MenuGroup } from './api';

export interface DraftOption {
  id?: string;
  name: string;
  /** rupees as typed */
  price: string;
  isVeg: boolean;
  available: boolean;
}
export interface DraftGroup {
  id?: string;
  name: string;
  min: string;
  max: string;
  options: DraftOption[];
}

export const MAX_GROUPS = 10;
export const MAX_OPTIONS = 30;

export const newOption = (isVeg = true): DraftOption => ({ name: '', price: '0', isVeg, available: true });
export const newGroup = (isVeg = true): DraftGroup => ({ name: '', min: '0', max: '1', options: [newOption(isVeg), newOption(isVeg)] });

export function toDraftGroups(groups: MenuGroup[]): DraftGroup[] {
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    min: String(g.minSelect),
    max: String(g.maxSelect),
    options: g.options.map((o) => ({ id: o.id, name: o.name, price: paiseToRupees(o.pricePaise), isVeg: o.isVeg, available: o.available ?? true })),
  }));
}

/** Valid drafts -> API body (call only when validateGroups(...) is empty). */
export function fromDraftGroups(groups: DraftGroup[]): MenuGroup[] {
  return groups.map((g) => ({
    ...(g.id ? { id: g.id } : {}),
    name: g.name.trim(),
    minSelect: Number(g.min),
    maxSelect: Number(g.max),
    options: g.options.map((o) => ({
      ...(o.id ? { id: o.id } : {}),
      name: o.name.trim(),
      pricePaise: rupeesToPaise(o.price) ?? 0,
      isVeg: o.isVeg,
      available: o.available,
    })),
  }));
}

const isInt = (s: string) => /^\d+$/.test(s.trim());

/** Keys: `g0.name`, `g0.min`, `g0.max`, `g0.options`, `g0.o1.name`, `g0.o1.price`. */
export function validateGroups(groups: DraftGroup[]): Record<string, string> {
  const e: Record<string, string> = {};
  groups.forEach((g, i) => {
    const k = `g${i}`;
    if (!g.name.trim()) e[`${k}.name`] = 'Name this group, e.g. "Size" or "Add-ons".';
    else if (g.name.trim().length > 80) e[`${k}.name`] = 'Use 80 characters or fewer.';
    if (g.options.length === 0) e[`${k}.options`] = 'Add at least one option.';
    if (g.options.length > MAX_OPTIONS) e[`${k}.options`] = `At most ${MAX_OPTIONS} options per group.`;
    g.options.forEach((o, j) => {
      if (!o.name.trim()) e[`${k}.o${j}.name`] = 'Name this option.';
      if (rupeesToPaise(o.price) === null) e[`${k}.o${j}.price`] = 'Enter a price like 20 or 20.50 (0 for free).';
    });
    const minOk = isInt(g.min);
    const maxOk = isInt(g.max);
    if (!minOk) e[`${k}.min`] = 'Enter a whole number, 0 or more.';
    if (!maxOk || Number(g.max) < 1) e[`${k}.max`] = 'Enter a whole number, 1 or more.';
    if (minOk && maxOk && Number(g.max) >= 1) {
      if (Number(g.min) > Number(g.max)) e[`${k}.min`] = "Minimum choices can't be more than the maximum.";
      else if (Number(g.max) > g.options.length) e[`${k}.max`] = `Maximum can't be more than the number of options (${g.options.length}).`;
    }
  });
  return e;
}

export interface CustomizationEditorProps {
  value: DraftGroup[];
  onChange: (next: DraftGroup[]) => void;
  /** from validateGroups */
  errors: Record<string, string>;
  /** default veg flag for new options */
  defaultVeg?: boolean;
  disabled?: boolean;
}

export function CustomizationEditor({ value, onChange, errors, defaultVeg = true, disabled }: CustomizationEditorProps) {
  const setGroup = (i: number, patch: Partial<DraftGroup>) => onChange(value.map((g, k) => (k === i ? { ...g, ...patch } : g)));
  const setOption = (i: number, j: number, patch: Partial<DraftOption>) =>
    setGroup(i, { options: value[i]!.options.map((o, k) => (k === j ? { ...o, ...patch } : o)) });

  return (
    <div className="flex flex-col gap-4">
      {value.length === 0 ? <p className="text-sm text-slate-600">No customizations. Add a group if customers can choose a size, extras or a spice level.</p> : null}
      {value.map((g, i) => (
        <fieldset key={i} className="flex flex-col gap-3 rounded-card border border-slate-200 bg-surface-muted p-3 sm:p-4" disabled={disabled}>
          <legend className="px-1 text-sm font-semibold text-slate-900">Group {i + 1}{g.name.trim() ? `: ${g.name.trim()}` : ''}</legend>
          <Field label={`Group ${i + 1} name`} required error={errors[`g${i}.name`]}>
            <Input value={g.name} onChange={(e) => setGroup(i, { name: e.target.value })} maxLength={80} placeholder="e.g. Size" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`Group ${i + 1} minimum choices`} hint="0 makes the group optional" error={errors[`g${i}.min`]}>
              <Input type="number" inputMode="numeric" min={0} value={g.min} onChange={(e) => setGroup(i, { min: e.target.value })} />
            </Field>
            <Field label={`Group ${i + 1} maximum choices`} error={errors[`g${i}.max`]}>
              <Input type="number" inputMode="numeric" min={1} value={g.max} onChange={(e) => setGroup(i, { max: e.target.value })} />
            </Field>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-slate-800">Options</p>
            {errors[`g${i}.options`] ? <p role="alert" className="text-sm font-medium text-danger-700">{errors[`g${i}.options`]}</p> : null}
            {g.options.map((o, j) => (
              <div key={j} className="grid grid-cols-[1fr_7rem] items-start gap-2 rounded-control bg-surface p-2 sm:grid-cols-[1fr_8rem_auto_auto]">
                <Field label={`Group ${i + 1} option ${j + 1} name`} error={errors[`g${i}.o${j}.name`]}>
                  <Input value={o.name} onChange={(e) => setOption(i, j, { name: e.target.value })} maxLength={80} />
                </Field>
                <Field label={`Group ${i + 1} option ${j + 1} price`} error={errors[`g${i}.o${j}.price`]}>
                  <Input inputMode="decimal" prefix="₹" value={o.price} onChange={(e) => setOption(i, j, { price: e.target.value })} />
                </Field>
                <div className="col-span-2 flex flex-wrap items-center gap-x-4 sm:col-span-1 sm:pt-7">
                  <Checkbox label="Veg" checked={o.isVeg} onChange={(e) => setOption(i, j, { isVeg: e.target.checked })} aria-label={`Group ${i + 1} option ${j + 1} is vegetarian`} />
                  <Checkbox label="Available" checked={o.available} onChange={(e) => setOption(i, j, { available: e.target.checked })} aria-label={`Group ${i + 1} option ${j + 1} is available`} />
                </div>
                <div className="col-span-2 sm:col-span-1 sm:pt-7">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="trash"
                    aria-label={`Remove group ${i + 1} option ${j + 1}`}
                    onClick={() => setGroup(i, { options: g.options.filter((_, k) => k !== j) })}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
            {g.options.length < MAX_OPTIONS ? (
              <div>
                <Button variant="secondary" size="sm" icon="plus" onClick={() => setGroup(i, { options: [...g.options, newOption(defaultVeg)] })}>
                  Add option to group {i + 1}
                </Button>
              </div>
            ) : null}
          </div>

          <div>
            <Button variant="ghost" size="sm" icon="trash" onClick={() => onChange(value.filter((_, k) => k !== i))}>
              Remove group {i + 1}
            </Button>
          </div>
        </fieldset>
      ))}
      {value.length < MAX_GROUPS ? (
        <div>
          <Button variant="secondary" icon="plus" onClick={() => onChange([...value, newGroup(defaultVeg)])} disabled={disabled}>
            Add customization group
          </Button>
        </div>
      ) : null}
    </div>
  );
}
