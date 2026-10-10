/**
 * Store settings (PRD R-4): temporary pause (15 / 30 / 60 min) and resume, weekly opening hours (overnight
 * allowed), and kitchen defaults (prep time, packaging fee, delivery radius). Times are India Standard Time.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, CardHeader, Field, InlineError, Input, PageHeader, Price, useToast } from '../../components/ui';
import { useCountdown } from '../../components/ui/Countdown';
import { fieldErrors } from '../../lib/errors';
import { formatDuration, formatTime } from '../../lib/format';
import { HoursEditor } from './HoursEditor';
import { cacheRestaurant, paiseToRupees, restaurantApi, rupeesToPaise, type OwnerRestaurant } from './api';
import { slotsFromWeek, validateWeek, weekFromSlots, type WeekState } from './hours';
import { useCurrentRestaurant } from './RestaurantContext';

export const PAUSE_OPTIONS = [15, 30, 60];

function PauseCard({ r }: { r: OwnerRestaurant }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const left = useCountdown(r.pausedUntil);
  const paused = Boolean(r.pausedUntil) && (left ?? 0) > 0;
  const pause = useMutation({
    mutationFn: (m: number) => restaurantApi.pause(r.id, m),
    onSuccess: (u, m) => {
      cacheRestaurant(qc, u);
      toast({ title: `Ordering paused for ${m} minutes`, tone: 'success' });
    },
  });
  const resume = useMutation({
    mutationFn: () => restaurantApi.resume(r.id),
    onSuccess: (u) => {
      cacheRestaurant(qc, u);
      toast({ title: 'Ordering resumed', tone: 'success' });
    },
  });
  return (
    <Card>
      <CardHeader title="Pause ordering" description="Need a break? Customers can't place new orders while paused. Orders already accepted continue." />
      <div className="mt-3 flex flex-col gap-3" aria-live="polite">
        {paused ? (
          <>
            <p className="text-[0.9375rem] text-slate-800">
              Paused until <strong>{formatTime(r.pausedUntil)}</strong> ({formatDuration(left ?? 0)} left).
            </p>
            <div><Button onClick={() => resume.mutate()} loading={resume.isPending}>Resume ordering now</Button></div>
          </>
        ) : (
          <>
            <p className="text-[0.9375rem] text-slate-700">{r.status === 'APPROVED' ? 'Ordering is open (subject to your opening hours).' : 'You can pause ordering once your restaurant is approved.'}</p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Pause for">
              {PAUSE_OPTIONS.map((m) => (
                <Button key={m} variant="secondary" disabled={r.status !== 'APPROVED'} loading={pause.isPending && pause.variables === m} onClick={() => pause.mutate(m)}>
                  Pause {m} min
                </Button>
              ))}
            </div>
          </>
        )}
        <InlineError error={pause.error ?? resume.error} />
      </div>
    </Card>
  );
}

function HoursCard({ r }: { r: OwnerRestaurant }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [week, setWeek] = useState<WeekState>(() => weekFromSlots(r.hours));
  const [show, setShow] = useState(false);
  const check = validateWeek(week);
  const next = slotsFromWeek(week);
  const dirty = JSON.stringify(next) !== JSON.stringify(slotsFromWeek(weekFromSlots(r.hours)));
  const save = useMutation({
    mutationFn: () => restaurantApi.setHours(r.id, next),
    onSuccess: (u) => {
      cacheRestaurant(qc, u);
      setShow(false);
      toast({ title: 'Opening hours saved', tone: 'success' });
    },
  });
  return (
    <Card>
      <CardHeader title="Opening hours" description="India Standard Time. A closing time earlier than the opening time runs past midnight (for example 18:00 to 02:00)." />
      <div className="mt-3 flex flex-col gap-4">
        <HoursEditor value={week} onChange={setWeek} errors={show ? check.errors : {}} />
        <InlineError error={save.error} />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            loading={save.isPending}
            disabled={!dirty}
            onClick={() => {
              if (!check.valid) return setShow(true);
              save.mutate();
            }}
          >
            Save hours
          </Button>
          {!dirty ? <span className="text-sm text-slate-600">No changes to save.</span> : null}
          {dirty && show && !check.valid ? <span role="alert" className="text-sm font-medium text-danger-700">Fix the highlighted times to save.</span> : null}
        </div>
      </div>
    </Card>
  );
}

function KitchenCard({ r }: { r: OwnerRestaurant }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [prep, setPrep] = useState(String(r.avgPrepMinutes));
  const [fee, setFee] = useState(paiseToRupees(r.packagingFeePaise));
  const [radius, setRadius] = useState(String(r.deliveryRadiusKm));
  const [show, setShow] = useState(false);
  const errors: Record<string, string> = {};
  if (!/^\d+$/.test(prep) || Number(prep) < 5 || Number(prep) > 120) errors.prep = 'Enter whole minutes between 5 and 120.';
  if (rupeesToPaise(fee) === null) errors.fee = 'Enter an amount like 10 or 12.50 (0 for none).';
  const rad = Number(radius);
  if (!radius.trim() || !Number.isFinite(rad) || rad < 0.5 || rad > 15) errors.radius = 'Enter a radius between 0.5 and 15 km.';
  const dirty = prep !== String(r.avgPrepMinutes) || rupeesToPaise(fee) !== r.packagingFeePaise || rad !== r.deliveryRadiusKm;
  const save = useMutation({
    mutationFn: () => restaurantApi.patch(r.id, { avgPrepMinutes: Number(prep), packagingFeePaise: rupeesToPaise(fee)!, deliveryRadiusKm: rad }),
    onSuccess: (u) => {
      cacheRestaurant(qc, u);
      setShow(false);
      toast({ title: 'Kitchen settings saved', tone: 'success' });
    },
  });
  const server = fieldErrors(save.error);
  const err = (k: string, sk: string) => (show ? errors[k] : undefined) ?? server[sk];
  return (
    <Card>
      <CardHeader title="Kitchen defaults" description="Used for delivery estimates and as the starting point when you accept orders." />
      <form
        className="mt-3 grid gap-4 sm:grid-cols-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (Object.keys(errors).length) return setShow(true);
          save.mutate();
        }}
      >
        <Field label="Average prep time" error={err('prep', 'avgPrepMinutes')}>
          <Input type="number" inputMode="numeric" min={5} max={120} suffix="min" value={prep} onChange={(e) => setPrep(e.target.value)} />
        </Field>
        <Field label="Packaging fee per order" error={err('fee', 'packagingFeePaise')} hint={rupeesToPaise(fee) ? <>Customers pay <Price paise={rupeesToPaise(fee)!} size="sm" /></> : undefined}>
          <Input inputMode="decimal" prefix="₹" value={fee} onChange={(e) => setFee(e.target.value)} />
        </Field>
        <Field label="Delivery radius" error={err('radius', 'deliveryRadiusKm')}>
          <Input type="number" inputMode="decimal" step="0.5" min={0.5} max={15} suffix="km" value={radius} onChange={(e) => setRadius(e.target.value)} />
        </Field>
        <div className="sm:col-span-3 flex flex-wrap items-center gap-3">
          <Button type="submit" loading={save.isPending} disabled={!dirty}>Save settings</Button>
          {!dirty ? <span className="text-sm text-slate-600">No changes to save.</span> : null}
        </div>
        {save.isError && Object.keys(server).length === 0 ? <div className="sm:col-span-3"><InlineError error={save.error} /></div> : null}
      </form>
    </Card>
  );
}

export default function StoreSettingsPage() {
  const r = useCurrentRestaurant();
  return (
    <>
      <PageHeader title="Store settings" description={r.name} />
      <div className="flex flex-col gap-5">
        <PauseCard r={r} />
        <HoursCard r={r} />
        <KitchenCard r={r} />
      </div>
    </>
  );
}
