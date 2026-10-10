/**
 * Buttons and button-styled links. 44px tall by default (touch target); `sm` is 36px on fine pointers and
 * still 44px on touch screens.
 *
 *   <Button onClick={save} loading={mutation.isPending}>Save</Button>
 *   <Button variant="secondary" icon="plus">Add item</Button>
 *   <Button variant="danger" size="sm">Reject</Button>
 *   <ButtonLink to="/cart" variant="primary" iconRight="chevron-right">View cart</ButtonLink>
 *   <IconButton icon="x" label="Close" onClick={close} />
 */
import type { ComponentProps, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from './Icon';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

const base =
  'inline-flex items-center justify-center gap-2 font-semibold whitespace-nowrap select-none ' +
  'rounded-control transition-[background-color,color,border-color,box-shadow] duration-150 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ' +
  'disabled:cursor-not-allowed aria-disabled:cursor-not-allowed';

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-600 text-white shadow-raised hover:bg-brand-700 active:bg-brand-800 ' +
    'disabled:bg-slate-200 disabled:text-slate-500 disabled:shadow-none aria-disabled:bg-slate-200 aria-disabled:text-slate-500',
  secondary:
    'bg-surface text-slate-900 border border-slate-300 hover:bg-slate-50 hover:border-slate-400 active:bg-slate-100 ' +
    'disabled:text-slate-400 disabled:bg-slate-50 disabled:border-slate-200',
  ghost: 'text-slate-700 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200 disabled:text-slate-400 disabled:bg-transparent',
  danger:
    'bg-danger-700 text-white shadow-raised hover:bg-danger-800 active:bg-danger-800 ' +
    'disabled:bg-slate-200 disabled:text-slate-500 disabled:shadow-none',
  link: 'text-brand-700 underline-offset-4 hover:underline px-0! h-auto! min-h-0! disabled:text-slate-400',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm [@media(pointer:coarse)]:min-h-touch',
  md: 'h-11 px-4 text-[0.9375rem]',
  lg: 'h-12 px-6 text-base',
};

export function buttonClasses(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', fullWidth = false, className?: string) {
  return cn(base, variants[variant], sizes[size], fullWidth && 'w-full', className);
}

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon. */
  icon?: IconName;
  iconRight?: IconName;
  fullWidth?: boolean;
}

export interface ButtonProps extends ComponentProps<'button'>, CommonProps {
  /** Shows a spinner, sets aria-busy and blocks clicks (keeps the label for layout stability). */
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
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
  return (
    <button
      type={type}
      className={buttonClasses(variant, size, fullWidth, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner label={null} size={size === 'sm' ? 16 : 18} /> : icon ? <Icon name={icon} size={size === 'sm' ? 16 : 18} /> : null}
      {children}
      {iconRight && !loading ? <Icon name={iconRight} size={size === 'sm' ? 16 : 18} /> : null}
    </button>
  );
}

export interface ButtonLinkProps extends LinkProps, CommonProps {
  children?: ReactNode;
}

/** A react-router <Link> that looks like a Button. */
export function ButtonLink({ variant = 'primary', size = 'md', icon, iconRight, fullWidth, className, children, ...rest }: ButtonLinkProps) {
  return (
    <Link className={buttonClasses(variant, size, fullWidth, className)} {...rest}>
      {icon ? <Icon name={icon} size={size === 'sm' ? 16 : 18} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={size === 'sm' ? 16 : 18} /> : null}
    </Link>
  );
}

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  icon: IconName;
  /** Required accessible name. */
  label: string;
  variant?: Exclude<ButtonVariant, 'link'>;
  size?: ButtonSize;
}

/** Square icon-only button; always 44x44 hit area. */
export function IconButton({ icon, label, variant = 'ghost', size = 'md', type = 'button', className, ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(base, variants[variant], 'p-0', size === 'sm' ? 'size-9 [@media(pointer:coarse)]:size-touch' : 'size-touch', className)}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 18 : 20} />
    </button>
  );
}
