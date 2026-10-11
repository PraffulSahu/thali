/**
 * Class-name helper with Tailwind conflict resolution (tailwind-merge v3, Tailwind v4).
 *
 *   cn('a', cond && 'b', undefined)              -> 'a b'
 *   cn('border-line', 'border-acc')              -> 'border-acc'     (later class wins)
 *   cn('shadow-pri', 'shadow-none')              -> 'shadow-none'
 *   cn('text-sm', 'text-pri-fg')                 -> 'text-sm text-pri-fg'   (size vs colour: no conflict)
 *
 * The merge config knows the Masala tokens from styles.css (`@theme`), so component defaults can be overridden
 * from `className` without `!` (e.g. `<Button className="border-acc shadow-none">`). Anything that isn't a
 * non-empty string (false, null, undefined, numbers) is skipped.
 */
import { extendTailwindMerge } from 'tailwind-merge';

/*
 * Colours: tailwind-merge already treats any `bg-/text-/border-/ring-/shadow-<name>` it doesn't otherwise know as a
 * colour, which covers every semantic token (bg, card, fill, line, line-2, fg…fg-3, pri, pri-fg, acc, acc-soft,
 * ok/warn/bad/info(+-bg) …). Do NOT list them as theme literals: names shared with shadows (`card`, `pri`) would
 * then turn `shadow-card` / `shadow-pri` into shadow *colours* and stop them conflicting with `shadow-none`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      radius: ['tag', 'xs', 'badge', 'item', 'control', 'field', 'card', 'card-lg', 'panel', 'block', 'art', 'pill'],
      shadow: ['card', 'float', 'modal', 'pri', 'seg', 'raised', 'overlay'],
      spacing: ['touch'],
      container: ['public', 'discover', 'page', 'checkout', 'content', 'prose'],
      font: ['display', 'sans', 'mono'],
      animate: [
        'rise', 'pulse-live', 'pulse-ok', 'shimmer', 'pop', 'fade', 'open', 'spin-btn', 'dock', 'tray', 'arrive',
        'slidein', 'in', 'urgent', 'grow', 'blink', 'swap', 'bob', 'bob2', 'split', 'toast', 'bump', 'dash',
        'fade-in', 'pop-in', 'sheet-up', 'sheet-left', 'sheet-right',
      ],
    },
    classGroups: {
      // `ring-on-color` (styles.css @utility) sets outline-color, it is not a ring colour.
      'outline-color': ['ring-on-color'],
    },
  },
});

export function cn(...parts: unknown[]): string {
  return twMerge(parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' '));
}
