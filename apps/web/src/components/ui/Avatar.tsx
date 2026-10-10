/**
 * Avatar (design-spec §3.34): photo (IDN-3 `avatarUrl`) with an initials fallback (also on image error).
 *
 *   <Avatar name="Nisha Kapoor" size={30} />                 // "NK"
 *   <Avatar name={user.name} src={user.avatarUrl} size={36} bordered />
 *   <Avatar name="Spice Route" hue={hueFor(restaurant.id)} shape="tile" />   // brand tile, white initials
 *
 * Sizes: 30 admin sidebar · 32 owner sidebar / cart · 36 header & partner card · 40 rider row.
 */
import { useState } from 'react';
import { cn } from '../../lib/cn';

/** Six restaurant identity hues (design-spec §1.2), picked by `hueFor(id)` when there is no image. */
export const RESTAURANT_HUES = ['#c2410c', '#15803d', '#a16207', '#0e7490', '#7c3aed', '#be185d'] as const;

export function hueFor(id: string | null | undefined): string {
  const s = id ?? '';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return RESTAURANT_HUES[h % RESTAURANT_HUES.length]!;
}

/** First letter of first + last name ("Nisha Kapoor" → "NK"; "Prafful" → "P"). */
export function initials(name: string | null | undefined, max = 2): string {
  const words = (name ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 || max === 1 ? [words[0]![0]] : [words[0]![0], words[words.length - 1]![0]];
  return letters.join('').toUpperCase();
}

export interface AvatarProps {
  name: string | null | undefined;
  src?: string | null;
  size?: number;
  /** Brand/cart avatars: hue fill + white initials. */
  hue?: string;
  shape?: 'circle' | 'tile';
  bordered?: boolean;
  /** Decorative when the name is printed next to it (default true). */
  decorative?: boolean;
  className?: string;
}

export function Avatar({ name, src, size = 36, hue, shape = 'circle', bordered, decorative = true, className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImg = Boolean(src) && !failed;
  const fontSize = Math.round(size * 0.38);
  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name ?? undefined}
      aria-hidden={decorative || undefined}
      className={cn(
        'relative inline-grid shrink-0 select-none place-items-center overflow-hidden font-semibold leading-none',
        shape === 'tile' ? 'rounded-badge' : 'rounded-full',
        hue ? 'text-white' : 'bg-fill text-fg',
        bordered && 'border border-line',
        showImg && 'shadow-[0_0_0_1px_var(--line)]',
        className,
      )}
      style={{ width: size, height: size, fontSize, background: hue && !showImg ? hue : undefined }}
    >
      {showImg ? (
        <img src={src!} alt="" className="size-full object-cover" onError={() => setFailed(true)} />
      ) : (
        initials(name, size <= 30 ? 2 : shape === 'tile' || hue ? 2 : 1)
      )}
    </span>
  );
}
