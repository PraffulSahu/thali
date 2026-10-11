/**
 * Pause / resume ordering (design-spec 20-15, store settings Pause card): 15 / 30 / 60 min or a custom number of
 * minutes → `POST /owner/restaurants/:id/pause {minutes}`; `POST …/resume` ends it early. Both refresh the
 * restaurant caches and the dashboard (its open-state chip).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button, ChoicePills, InlineError, Input, useToast } from '../../components/ui';
import { useCountdown } from '../../components/ui/Countdown';
import { errorMessage } from '../../lib/errors';
import { formatTime } from '../../lib/format';
import { cacheRestaurant, keys, restaurantApi, type OwnerRestaurant } from './api';
import { Popover } from '../../components/ui/Popover';

export const PAUSE_OPTIONS = [15, 30, 60];
export const PAUSE_MAX_MINUTES = 10080;

/** True while `pausedUntil` is in the future (ticks every second so the UI flips back by itself). */
export function usePaused(r: Pick<OwnerRestaurant, 'pausedUntil'>): boolean {
  const left = useCountdown(r.pausedUntil);
  return Boolean(r.pausedUntil) && (left ?? 0) > 0;
}

export function usePauseActions(r: OwnerRestaurant) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const after = (u: OwnerRestaurant) => {
    cacheRestaurant(qc, u);
    void qc.invalidateQueries({ queryKey: keys.dashboard(r.id) });
  };
  const pause = useMutation({
    mutationFn: (minutes: number) => restaurantApi.pause(r.id, minutes),
    onSuccess: (u, m) => {
      after(u);
      toast({ title: `Orders paused for ${m} min`, description: u.pausedUntil ? `New orders resume at ${formatTime(u.pausedUntil)}.` : undefined, tone: 'success' });
    },
  });
  const resume = useMutation({
    mutationFn: () => restaurantApi.resume(r.id),
    onSuccess: (u) => {
      after(u);
      toast({ title: 'Taking orders again', tone: 'success' });
    },
    onError: (e) => toast({ title: "Couldn't resume orders", description: errorMessage(e), tone: 'danger' }),
  });
  return { pause, resume };
}

/** 15 / 30 / 60 pills + custom minutes. `onPause` resolves when the request finishes. */
export function PauseChoices({ onPause, pending, disabled, error }: { onPause: (minutes: number) => void; pending?: boolean; disabled?: boolean; error?: unknown }) {
  const [choice, setChoice] = useState<string>('30');
  const [custom, setCustom] = useState('');
  const id = useId();
  const customMin = Number(custom);
  const customValid = /^\d+$/.test(custom.trim()) && customMin >= 1 && customMin <= PAUSE_MAX_MINUTES;
  const minutes = choice === 'custom' ? (customValid ? customMin : null) : Number(choice);
  return (
    <div className="flex flex-col gap-2.5">
      <ChoicePills
        label="Pause for"
        columns={4}
        value={choice}
        onChange={setChoice}
        options={[...PAUSE_OPTIONS.map((m) => ({ value: String(m), label: `${m} min`, disabled })), { value: 'custom', label: 'Custom', disabled }]}
      />
      {choice === 'custom' ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-min`} className="text-sm font-medium text-fg">
            Minutes
          </label>
          <Input
            id={`${id}-min`}
            type="number"
            inputMode="numeric"
            min={1}
            max={PAUSE_MAX_MINUTES}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            suffix="min"
            aria-invalid={custom !== '' && !customValid ? true : undefined}
            aria-describedby={`${id}-hint`}
          />
          <p id={`${id}-hint`} className={custom !== '' && !customValid ? 'text-[13px] text-bad' : 'text-[13px] text-fg-3'}>
            {custom !== '' && !customValid ? `Enter whole minutes from 1 to ${PAUSE_MAX_MINUTES}.` : 'Up to 7 days.'}
          </p>
        </div>
      ) : null}
      <InlineError error={error} />
      <Button shape="block" fullWidth loading={pending} disabled={disabled || minutes === null} onClick={() => minutes !== null && onPause(minutes)}>
        {minutes !== null ? `Pause for ${minutes} min` : 'Pause orders'}
      </Button>
    </div>
  );
}

/** Board header action: "Pause orders" popover, or "Resume orders" while paused. */
export function PauseButton({ restaurant }: { restaurant: OwnerRestaurant }) {
  const paused = usePaused(restaurant);
  const { pause, resume } = usePauseActions(restaurant);
  const approved = restaurant.status === 'APPROVED';
  if (paused) {
    return (
      <Button variant="outline" icon="clock" onClick={() => resume.mutate()} loading={resume.isPending}>
        Resume orders
      </Button>
    );
  }
  return (
    <Popover
      label="Pause new orders"
      panelClassName="w-[320px] p-3"
      trigger={(p) => (
        <Button variant="outline" {...p} disabled={!approved} title={approved ? undefined : 'You can pause once your restaurant is approved'}>
          Pause orders
        </Button>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-2.5">
          <p className="text-[14.5px] font-medium text-fg">Pause new orders</p>
          <p className="text-[13px] text-fg-3">Customers see &ldquo;Temporarily not accepting orders&rdquo;. Orders you already accepted carry on.</p>
          <PauseChoices
            pending={pause.isPending}
            error={pause.error}
            onPause={(m) => pause.mutate(m, { onSuccess: close })}
          />
        </div>
      )}
    </Popover>
  );
}
