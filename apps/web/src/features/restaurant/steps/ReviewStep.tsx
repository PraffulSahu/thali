/** Step 7: review everything and submit for verification/approval (DRAFT or REJECTED only). */
import { useMutation } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Badge, Button, ButtonLink, Card, CardHeader, InlineError, useToast } from '../../../components/ui';
import { ApiError } from '../../../lib/errors';
import { formatPhone } from '../../../lib/format';
import { missingForSubmit, restaurantApi, DOCUMENT_TYPES, type OwnerRestaurant } from '../api';
import { summarizeHours } from '../hours';
import { type StepProps } from './StepFrame';

function Row({ label, children, step, base }: { label: string; children: ReactNode; step: string; base: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 py-2">
      <div className="min-w-0">
        <dt className="text-sm text-slate-600">{label}</dt>
        <dd className="text-[0.9375rem] text-slate-900">{children}</dd>
      </div>
      <Link to={`${base}?step=${step}`} className="text-sm font-semibold text-brand-700 underline-offset-4 hover:underline" aria-label={`Edit ${label}`}>
        Edit
      </Link>
    </div>
  );
}

const STEP_LABEL: Record<string, string> = {
  business: 'Business', location: 'Location', hours: 'Hours', media: 'Photos', documents: 'Documents', settlement: 'Settlement',
};

export function ReviewStep({ restaurant, onSaved, back }: StepProps) {
  const { toast } = useToast();
  const r = restaurant as OwnerRestaurant;
  const base = `/restaurant/onboarding/${r.id}`;
  const missing = missingForSubmit(r);
  const canSubmit = r.status === 'DRAFT' || r.status === 'REJECTED';

  const submit = useMutation({
    mutationFn: () => restaurantApi.submit(r.id),
    onSuccess: (updated) => {
      onSaved(updated);
      toast({ title: 'Submitted for review', tone: 'success' });
    },
  });
  const serverMissing =
    submit.error instanceof ApiError && Array.isArray((submit.error.details as { missing?: unknown } | undefined)?.missing)
      ? ((submit.error.details as { missing: string[] }).missing)
      : [];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Review and submit</h2>
        <p className="mt-1 text-[0.9375rem] text-slate-600">
          We&rsquo;ll email a verification link to {r.businessEmail ?? 'your business email'}. After you verify it, our team reviews your restaurant.
        </p>
      </div>

      <Card>
        <CardHeader title="Your details" />
        <dl className="divide-y divide-slate-100">
          <Row label="Restaurant" step="business" base={base}>
            {r.name}
            {r.businessName ? <span className="block text-sm text-slate-600">{r.businessName}</span> : null}
          </Row>
          <Row label="Contact" step="business" base={base}>
            {r.phone ? formatPhone(r.phone) : 'Not set'} · {r.businessEmail ?? 'No email'}
          </Row>
          <Row label="Cuisines" step="business" base={base}>{r.cuisines.length ? r.cuisines.join(', ') : 'Not set'}</Row>
          <Row label="Address" step="location" base={base}>
            {r.address ? `${r.address.line1}${r.address.line2 ? `, ${r.address.line2}` : ''}, ${r.address.city} ${r.address.pincode}` : 'Not set'}
            {r.location ? <span className="block text-sm text-slate-600">Pin set · delivers within {r.deliveryRadiusKm} km</span> : null}
          </Row>
          <Row label="Opening hours" step="hours" base={base}>
            {r.hours.length ? (
              <ul className="text-sm">{summarizeHours(r.hours).map((l) => <li key={l}>{l}</li>)}</ul>
            ) : 'Not set'}
          </Row>
          <Row label="Documents" step="documents" base={base}>
            {r.documents.length ? r.documents.map((d) => DOCUMENT_TYPES.find((t) => t.type === d.type)?.label ?? d.type).join(', ') : 'None uploaded'}
          </Row>
          <Row label="Settlement account" step="settlement" base={base}>
            {r.settlement ? `${r.settlement.accountHolder} · ending ${r.settlement.last4}` : 'Not set'}
          </Row>
        </dl>
      </Card>

      {canSubmit && missing.length > 0 ? (
        <Card tone="warn">
          <div role="status">
          <h3 className="text-base font-semibold text-warn-800">Complete these before submitting</h3>
          <ul className="mt-2 flex flex-col gap-1">
            {missing.map((m) => (
              <li key={m.key} className="flex flex-wrap items-center gap-2 text-[0.9375rem]">
                <Badge tone="warn">{STEP_LABEL[m.step] ?? m.step}</Badge>
                <span>{m.label}</span>
                <Link to={`${base}?step=${m.step}`} className="text-sm font-semibold text-brand-700 underline-offset-4 hover:underline">Fix</Link>
              </li>
            ))}
          </ul>
          </div>
        </Card>
      ) : null}

      {serverMissing.length > 0 ? (
        <p role="alert" className="text-sm font-medium text-danger-700">The server says these are still missing: {serverMissing.join(', ')}.</p>
      ) : (
        <InlineError error={submit.error} />
      )}

      {canSubmit ? (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button variant="secondary" onClick={back}>Back</Button>
          <Button onClick={() => submit.mutate()} loading={submit.isPending} disabled={missing.length > 0} aria-describedby={missing.length ? 'submit-blocked' : undefined}>
            {r.status === 'REJECTED' ? 'Resubmit for review' : 'Submit for review'}
          </Button>
          {missing.length > 0 ? <span id="submit-blocked" className="sr-only">Submit is unavailable until the items listed above are complete.</span> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          <Button variant="secondary" onClick={back}>Back</Button>
          <ButtonLink to="/restaurant">Go to dashboard</ButtonLink>
        </div>
      )}
    </div>
  );
}
