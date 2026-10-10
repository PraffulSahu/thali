/**
 * Buttons and button-styled links (design-spec §3.1). Pill-shaped by default; `shape="block"` gives the 12px
 * radius card-action buttons (Accept, Mark ready, Accept offer). On touch screens every size grows to 44px.
 *
 *   <Button onClick={save} loading={mutation.isPending}>Save</Button>
 *   <Button variant="outline" icon="plus">Add item</Button>          // 'secondary' is an alias of 'outline'
 *   <Button variant="tonal">Add to cart</Button>
 *   <Button variant="danger-outline" shape="block" size="lg">Reject</Button>
 *   <Button variant="primary" shape="block" size="lg" fullWidth>Accept · 20 min</Button>
 *   <ButtonLink to="/cart" iconRight="arrow-right">Checkout · ₹558</ButtonLink>
 *   <IconButton icon="x" label="Close" onClick={close} />
 *
 * Variants: primary · tonal · outline (secondary) · ghost · dark · on-chili · on-chili-outline · on-ink ·
 *           on-ink-outline · danger (solid) · danger-outline · link · link-accent
 * Sizes:    xs 30 · sm 36 · md 40 (default) · lg 48 · xl 54 (marketing CTA)
 */
import type { ComponentProps, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from './Icon';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'tonal'
  | 'ghost'
  | 'dark'
  | 'on-chili'
  | 'on-chili-outline'
  | 'on-ink'
  | 'on-ink-outline'
  | 'danger'
  | 'danger-outline'
  | 'link'
  | 'link-accent';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type ButtonShape = 'pill' | 'block';

const base =
  'inline-flex items-center justify-center gap-2 font-bold leading-none whitespace-nowrap select-none border border-transparent ' +
  'transition-[transform,background-color,color,border-color,box-shadow,opacity] duration-150 ' +
  'disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45 ' +
  '[@media(pointer:coarse)]:min-h-touch';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-pri text-pri-fg shadow-pri not-disabled:hover:bg-pri-h',
  secondary: 'bg-card text-fg border-line not-disabled:hover:border-line-2',
  outline: 'bg-card text-fg border-line not-disabled:hover:border-line-2',
  tonal:
    'bg-acc-soft text-acc-fg not-disabled:hover:bg-[color-mix(in_srgb,var(--acc-soft),var(--acc)_8%)]',
  ghost: 'bg-transparent text-fg-2 not-disabled:hover:bg-fill not-disabled:hover:text-fg aria-[current=page]:bg-fill aria-[current=page]:text-fg',
  dark: 'bg-[#141414] text-white not-disabled:hover:-translate-y-px',
  'on-chili': 'bg-white text-[#a8320b] not-disabled:hover:-translate-y-px',
  'on-chili-outline': 'bg-transparent text-white border-white/50 not-disabled:hover:border-white',
  'on-ink': 'bg-[#ffc145] text-[#141414] not-disabled:hover:-translate-y-px',
  'on-ink-outline': 'bg-transparent text-white border-white/35 not-disabled:hover:border-white/70',
  danger: 'bg-bad text-bg not-disabled:hover:opacity-90',
  'danger-outline': 'bg-card text-bad border-line not-disabled:hover:border-bad',
  link: 'border-0 bg-transparent px-0! h-auto! min-h-0! font-medium text-fg underline underline-offset-2 hover:text-acc-fg',
  'link-accent': 'border-0 bg-transparent px-0! h-auto! min-h-0! font-extrabold text-acc-fg hover:underline underline-offset-4',
};

const sizes: Record<ButtonSize, string> = {
  xs: 'h-[30px] px-3 text-[12.5px]',
  sm: 'h-9 px-3.5 text-[13.5px]',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-[15px]',
  xl: 'h-[54px] px-[26px] text-base',
};

const iconSize: Record<ButtonSize, number> = { xs: 14, sm: 15, md: 16, lg: 17, xl: 18 };

export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  fullWidth = false,
  className?: string,
  shape: ButtonShape = 'pill',
) {
  return cn(base, sizes[size], variants[variant], shape === 'block' ? 'rounded-control' : 'rounded-pill', fullWidth && 'w-full', className);
}

/** 16px spinner arc used inside buttons (design-spec §3.1 loading state). */
export function ButtonSpinner({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={3} aria-hidden="true" className="shrink-0 animate-spin-btn">
      <path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round" />
    </svg>
  );
}

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
  /** Leading icon. */
  icon?: IconName;
  iconRight?: IconName;
  fullWidth?: boolean;
}

export interface ButtonProps extends ComponentProps<'button'>, CommonProps {
  /** Shows a spinner, sets aria-busy and blocks clicks (keeps the label). */
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  shape,
  icon,
  iconRight,
  fullWidth,
  loading = false,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  const is = iconSize[size];
  return (
    <button
      type={type}
      className={buttonClasses(variant, size, fullWidth, className, shape)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <ButtonSpinner size={is} /> : icon ? <Icon name={icon} size={is} /> : null}
      {children}
      {iconRight && !loading ? <Icon name={iconRight} size={is} /> : null}
    </button>
  );
}

export interface ButtonLinkProps extends LinkProps, CommonProps {
  children?: ReactNode;
}

/** A react-router <Link> that looks like a Button. */
export function ButtonLink({ variant = 'primary', size = 'md', shape, icon, iconRight, fullWidth, className, children, ...rest }: ButtonLinkProps) {
  const is = iconSize[size];
  return (
    <Link className={buttonClasses(variant, size, fullWidth, className, shape)} {...rest}>
      {icon ? <Icon name={icon} size={is} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={is} /> : null}
    </Link>
  );
}

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  icon: IconName;
  /** Required accessible name. */
  label: string;
  variant?: Exclude<ButtonVariant, 'link' | 'link-accent'>;
  /** xs 32 · sm 36 · md 40 (default) · lg 44 */
  size?: ButtonSize;
  /** Small dot on the icon (e.g. unread notifications). */
  dot?: boolean;
}

const iconBox: Record<ButtonSize, string> = { xs: 'size-8', sm: 'size-9', md: 'size-10', lg: 'size-11', xl: 'size-[54px]' };

/** Circular icon-only button; 44px hit area on touch screens. */
export function IconButton({ icon, label, variant = 'ghost', size = 'md', dot, type = 'button', className, ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(base, variants[variant], 'relative rounded-pill p-0 [@media(pointer:coarse)]:min-w-touch', iconBox[size], className)}
      {...rest}
    >
      <Icon name={icon} size={size === 'xs' || size === 'sm' ? 16 : 18} />
      {dot ? <span aria-hidden="true" className="absolute right-2.5 top-2 size-[7px] rounded-full bg-acc" /> : null}
    </button>
  );
}
