/**
 * Weekly hours editor (PRD R-4, design-spec §7.3 "Hours: weekly editor rows"). One row per day: open switch,
 * up to 3 slots (open / close time inputs), "+ add slot", copy to all days. A closing time earlier than the
 * opening time runs past midnight into the next day; identical open and close = open 24 hours (API semantics).
 */
import { Button, Icon, IconButton, Input, Toggle } from '../../components/ui';
import { DAY_NAMES, DAY_ORDER } from './api';
import { MAX_SLOTS_PER_DAY, slotKind, type WeekState } from './hours';

export interface HoursEditorProps {
  value: WeekState;
  onChange: (next: WeekState) => void;
  /** from validateWeek() */
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
    <div className="flex flex-col">
      {errors.week ? (
        <p role="alert" className="mb-2 text-[13px] font-medium text-bad">
          {errors.week}
        </p>
      ) : null}
      {DAY_ORDER.map((day) => {
        const slots = value[day] ?? [];
        const name = DAY_NAMES[day]!;
        const open = slots.length > 0;
        return (
          <fieldset key={day} disabled={disabled} className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-line py-3 last:border-0">
            <legend className="sr-only">{name}</legend>
            <div className="flex min-h-[46px] w-36 shrink-0 items-center gap-3">
              <Toggle checked={open} onChange={(v) => setDay(day, v ? [{ open: '09:00', close: '22:00' }] : [])} label={name} />
              <span className="text-sm font-medium text-fg" aria-hidden="true">
                {name}
              </span>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {!open ? <p className="flex min-h-[46px] items-center text-sm text-fg-3">Closed</p> : null}
              {slots.map((s, i) => {
                const err = errors[`${day}.${i}`];
                const kind = slotKind(s);
                return (
                  <div key={i} className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="w-[150px]">
                      <Input
                        type="time"
                        aria-label={`${name} slot ${i + 1} opens`}
                        aria-invalid={err ? true : undefined}
                        value={s.open}
                        onChange={(e) => setDay(day, slots.map((x, k) => (k === i ? { ...x, open: e.target.value } : x)))}
                        className="px-3 font-mono"
                      />
                      </span>
                      <span className="text-fg-3" aria-hidden="true">
                        –
                      </span>
                      <span className="w-[150px]">
                      <Input
                        type="time"
                        aria-label={`${name} slot ${i + 1} closes`}
                        value={s.close}
                        onChange={(e) => setDay(day, slots.map((x, k) => (k === i ? { ...x, close: e.target.value } : x)))}
                        className="px-3 font-mono"
                      />
                      </span>
                      <IconButton icon="trash" size="sm" label={`Remove ${name} slot ${i + 1}`} onClick={() => setDay(day, slots.filter((_, k) => k !== i))} />
                    </div>
                    {err ? <p className="text-[13px] font-medium text-bad">{err}</p> : null}
                    {kind === 'overnight' ? (
                      <p className="flex items-center gap-1 text-[13px] text-fg-3">
                        <Icon name="clock" size={14} /> Closes after midnight, on the next day.
                      </p>
                    ) : kind === 'allDay' ? (
                      <p className="flex items-center gap-1 text-[13px] text-fg-3">
                        <Icon name="clock" size={14} /> Open 24 hours.
                      </p>
                    ) : null}
                  </div>
                );
              })}
              {open ? (
                <div className="flex flex-wrap gap-x-3">
                  {slots.length < MAX_SLOTS_PER_DAY ? (
                    <Button variant="link" size="sm" icon="plus" onClick={() => setDay(day, [...slots, { open: '18:00', close: '23:00' }])} aria-label={`Add another slot for ${name}`}>
                      Add slot
                    </Button>
                  ) : null}
                  <Button variant="link" size="sm" onClick={() => copyToAll(day)} aria-label={`Copy ${name} hours to every day`}>
                    Copy to all days
                  </Button>
                </div>
              ) : null}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
