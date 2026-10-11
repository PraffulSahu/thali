import { describe, expect, it } from 'vitest';
import { resolveSelected } from '../../src/features/restaurant/selection';

const list = [
  { id: 'tt', status: 'APPROVAL_PENDING' },
  { id: 'sr', status: 'APPROVED' },
  { id: 'gl', status: 'APPROVED' },
];

describe('resolveSelected', () => {
  it('keeps a valid stored selection, whatever its status', () => {
    expect(resolveSelected(list, 'tt')?.id).toBe('tt');
    expect(resolveSelected(list, 'gl')?.id).toBe('gl');
  });
  it('without a (valid) selection prefers the first live restaurant over one still in onboarding/review', () => {
    expect(resolveSelected(list, null)?.id).toBe('sr');
    expect(resolveSelected(list, 'deleted')?.id).toBe('sr');
  });
  it('falls back to the first restaurant when none is live', () => {
    expect(resolveSelected([{ id: 'a', status: 'DRAFT' }, { id: 'b', status: 'SUSPENDED' }], null)?.id).toBe('a');
    expect(resolveSelected([{ id: 'x' }], null)?.id).toBe('x');
    expect(resolveSelected([], null)).toBeUndefined();
  });
});
