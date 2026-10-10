/**
 * Button row for forms and dialogs. Primary action last (right on desktop); on phones buttons stack
 * full-width with the primary on top. `sticky` pins the row to the bottom of the viewport on phones (long forms).
 *
 *   <FormActions>
 *     <Button variant="secondary" onClick={cancel}>Cancel</Button>
 *     <Button type="submit" loading={saving}>Save changes</Button>
 *   </FormActions>
 *   <FormActions align="between" start={<Button variant="ghost">Delete</Button>}>…</FormActions>
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface FormActionsProps {
  children: ReactNode;
  /** Optional element on the opposite side (e.g. a destructive "Delete"). */
  start?: ReactNode;
  align?: 'end' | 'start' | 'between';
  sticky?: boolean;
  className?: string;
}

export function FormActions({ children, start, align = 'end', sticky, className }: FormActionsProps) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 sm:flex-row sm:items-center',
        align === 'end' && 'sm:justify-end',
        align === 'start' && 'sm:justify-start',
        (align === 'between' || start) && 'sm:justify-between',
        sticky &&
          'sticky bottom-0 z-10 -mx-4 border-t border-line bg-card px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0',
        '[&>button]:w-full sm:[&>button]:w-auto [&>a]:w-full sm:[&>a]:w-auto',
        className,
      )}
    >
      {start ? <div className="flex flex-col-reverse gap-2 sm:flex-row [&>button]:w-full sm:[&>button]:w-auto">{start}</div> : null}
      {start ? <div className="flex flex-col-reverse gap-2 sm:flex-row [&>button]:w-full sm:[&>button]:w-auto">{children}</div> : children}
    </div>
  );
}
