import { describe, expect, it } from 'vitest';
import { cn } from '../../src/lib/cn';

describe('cn (tailwind-merge with Masala tokens)', () => {
  it('joins strings and skips falsy / non-string parts', () => {
    expect(cn('a', false, null, undefined, 0, '', 'b')).toBe('a b');
  });

  it.each([
    // [input, expected] — conflicts reported by the role-area agents
    [['border border-transparent', 'border-line'], 'border border-line'],
    [['border-line', 'border-acc'], 'border-acc'],
    [['border-line-2', 'border-pri'], 'border-pri'],
    [['min-w-56 p-2', 'min-w-0'], 'p-2 min-w-0'],
    [['p-2', 'p-3'], 'p-3'],
    [['shadow-pri', 'shadow-none'], 'shadow-none'],
    [['shadow-card', 'shadow-[0_0_0_1px_var(--line)]'], 'shadow-[0_0_0_1px_var(--line)]'],
    [['bg-card', 'bg-acc-soft'], 'bg-acc-soft'],
    [['rounded-pill', 'rounded-control'], 'rounded-control'],
    [['rounded-card', 'rounded-none'], 'rounded-none'],
    [['text-fg', 'text-acc-fg'], 'text-acc-fg'],
    [['text-sm', 'text-[13px]'], 'text-[13px]'],
    [['min-h-10', 'min-h-touch'], 'min-h-touch'],
    [['max-w-page', 'max-w-none'], 'max-w-none'],
    [['font-sans', 'font-mono'], 'font-mono'],
    [['animate-rise', 'animate-none'], 'animate-none'],
    [['w-[320px] p-3 min-w-56', 'w-[300px]'], 'p-3 min-w-56 w-[300px]'],
  ])('%j -> %s', (input, expected) => {
    expect(cn(...input)).toBe(expected);
  });

  it.each([
    // must NOT conflict
    ['text-sm text-pri-fg'],
    ['text-[26px] text-fg-3'],
    ['border-2 border-line'],
    ['shadow-pri shadow-acc'],
    ['bg-card border-line text-fg'],
    ['px-6 max-sm:px-4'],
    ['px-3 px-0!'],
    ['lbl text-[11px]!'],
    ['ring-on-color ring-acc'],
    ['shadow-card ring-1'],
    ['rounded-card border'],
    ['font-mono text-[11.5px] font-medium'],
  ])('keeps %s', (classes) => {
    expect(cn(classes)).toBe(classes);
  });
});
