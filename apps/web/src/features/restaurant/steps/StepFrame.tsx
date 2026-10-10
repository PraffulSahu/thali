import type { FormEvent, ReactNode } from 'react';
import { Button, FormActions, InlineError } from '../../../components/ui';
import type { OwnerRestaurant } from '../api';

/** What every wizard step receives. `restaurant` is undefined only while creating (business step). */
export interface StepProps {
  restaurant: OwnerRestaurant | undefined;
  /** Store the server's latest copy of the restaurant (cache) after a successful save. */
  onSaved: (r: OwnerRestaurant) => void;
  next: () => void;
  back: () => void;
}

export interface StepFrameProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  onSubmit: () => void;
  submitLabel?: string;
  submitting?: boolean;
  error?: unknown;
  onBack?: () => void;
  backLabel?: string;
}

export function StepFrame({ title, description, children, onSubmit, submitLabel = 'Save and continue', submitting, error, onBack, backLabel = 'Back' }: StepFrameProps) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!submitting) onSubmit();
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        {description ? <p className="mt-1 text-[0.9375rem] text-slate-600">{description}</p> : null}
      </div>
      {children}
      <InlineError error={error} />
      <FormActions sticky start={onBack ? <Button variant="secondary" onClick={onBack}>{backLabel}</Button> : undefined}>
        <Button type="submit" loading={submitting}>
          {submitLabel}
        </Button>
      </FormActions>
    </form>
  );
}
