/** Onboarding wizard step metadata (no components, so the status banner can use it without an import cycle). */
import { missingForSubmit, type OwnerRestaurant } from './api';

export const WIZARD_STEP_META = [
  { id: 'business', label: 'Business' },
  { id: 'location', label: 'Location' },
  { id: 'hours', label: 'Hours' },
  { id: 'media', label: 'Photos' },
  { id: 'documents', label: 'Documents' },
  { id: 'settlement', label: 'Settlement' },
  { id: 'review', label: 'Review' },
] as const;

export type StepId = (typeof WIZARD_STEP_META)[number]['id'];

export function isStepId(s: string | null | undefined): s is StepId {
  return WIZARD_STEP_META.some((x) => x.id === s);
}

/** First step with something missing, else the review step. */
export function firstIncompleteStep(r: OwnerRestaurant): StepId {
  const missing = missingForSubmit(r);
  const first = WIZARD_STEP_META.find((s) => missing.some((m) => m.step === s.id));
  return first?.id ?? 'review';
}

export function stepDone(r: OwnerRestaurant | undefined, id: StepId): boolean {
  if (!r) return false;
  if (id === 'review') return r.status !== 'DRAFT' && r.status !== 'REJECTED';
  if (id === 'media') return Boolean(r.images.cover || r.images.logo);
  return !missingForSubmit(r).some((m) => m.step === id);
}
