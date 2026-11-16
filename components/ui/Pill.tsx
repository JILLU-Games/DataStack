import { cn } from '@/lib/utils';
import React from 'react';

export interface PillProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export const Pill = React.forwardRef<HTMLButtonElement, PillProps>(
  ({ active = false, className, children, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 border px-2 text-[11px] transition-colors cursor-pointer whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50',
        active
          ? 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text)]'
          : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
);

Pill.displayName = 'Pill';

export default Pill;
