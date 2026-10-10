/**
 * Weekly hours editor (PRD R-4). Up to 3 slots per day; a closing time earlier than the opening time means the
 * slot runs past midnight into the next day; identical open and close means open 24 hours (API semantics).
 */
import { Button, Field, Icon, Input, Switch } from '../../components/ui';
import { DAY_NAMES, DAY_ORDER } from './api';
import { MAX_SLOTS_PER_DAY, slotKind, type WeekState } from './hours';

export interface HoursEditorProps {
  value: WeekState;
  onChange: (next: WeekState) => void;
  /** from validateWeek(); shown only for slots the user touched, or all when `showAll` */
  errors: Record<string, string>;
  disabled?: boolean;
}

export function HoursEditor({ value, onChange, errors, disabled }: HoursEditorProps) {
  const setDay = (day: number, slots: WeekState[number]) => onChange({ ...value, [day]: slots });
  const copyToAll = (day: number) => {
    const src = value[day] ?? [];
    const next: WeekState = {};
    for (let d = 0; d <= 6; d++) next[d] = src.map((s) => ({ ...s }));
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-3">
      {errors.week ? (
        <p role="alert" className="text-sm font-medium text-danger-700">
          {errors.week}
        </p>
      ) : null}
      {DAY_ORDER.map((day) => {
        const slots = value[day] ?? [];
        const name = DAY_NAMES[day]!;
        const open = slots.length > 0;
        return (
          <fieldset key={day} className="rounded-card border border-slate-200 bg-surface p-3 sm:p-4" disabled={disabled}>
            <legend className="sr-only">{name}</legend>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Switch
                label={name}
                description={open ? undefined : 'Closed'}
                checked={open}
                onChange={(e) => setDay(day, e.target.checked ? [{ open: '09:00', close: '22:00' }] : [])}
              />
              {open ? (
                <Button variant="ghost" size="sm" onClick={() => copyToAll(day)} aria-label={`Copy ${name} hours to every day`}>
                  Copy to all days
                </Button>
              ) : null}
            </div>
            {slots.map((s, i) => {
              const err = errors[`${day}.${i}`];
              const kind = slotKind(s);
              return (
                <div key={i} className="mt-2 flex flex-col gap-1">
                  <div className="flex flex-wrap items-end gap-3">
                    <Field label={`${name} slot ${i + 1} opens`} error={err}>
                      <Input
                        type="time"
                        value={s.open}
                        onChange={(e) => setDay(day, slots.map((x, k) => (k === i ? { ...x, open: e.target.value } : x)))}
                      />
                    </Field>
                    <Field label={`${name} slot ${i + 1} closes`}>
                      <Input
                        type="time"
                        value={s.close}
                        onChange={(e) => setDay(day, slots.map((x, k) => (k === i ? { ...x, close: e.target.value } : x)))}
                      />
                    </Field>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="trash"
                      aria-label={`Remove ${name} slot ${i + 1}`}
                      onClick={() => setDay(day, slots.filter((_, k) => k !== i))}
                    >
                      Remove
                    </Button>
                  </div>
                  {kind === 'overnight' ? (
                    <p className="flex items-center gap-1 text-sm text-slate-600">
                      <Icon name="clock" size={14} /> Closes after midnight, on the next day.
                    </p>
                  ) : kind === 'allDay' ? (
                    <p className="flex items-center gap-1 text-sm text-slate-600">
                      <Icon name="clock" size={14} /> Open 24 hours.
                    </p>
                  ) : null}
                </div>
              );
            })}
            {open && slots.length < MAX_SLOTS_PER_DAY ? (
              <Button
                variant="link"
                size="sm"
                icon="plus"
                className="mt-2"
                onClick={() => setDay(day, [...slots, { open: '18:00', close: '23:00' }])}
              >
                Add another slot for {name}
              </Button>
            ) : null}
          </fieldset>
        );
      })}
    </div>
  );
}
