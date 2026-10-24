import { cn } from '@/lib/utils';
import React from 'react';

interface PanelProps extends React.HTMLAttributes<HTMLElement> {
  title: string;
  action?: React.ReactNode;
  meta?: string;
  children: React.ReactNode;
  bodyClassName?: string;
}

export const Panel: React.FC<PanelProps> = ({
  title,
  action,
  meta,
  children,
  className,
  bodyClassName,
  ...props
}) => (
  <section className={cn('flex min-w-0 flex-col border border-[var(--border)] bg-[var(--surface)]', className)} {...props}>
    <header className="flex min-h-11 items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-2.5">
      <h2 className="text-[12px] font-medium text-[var(--text)]">{title}</h2>
      <div className="flex items-center gap-3">
        {meta && <span className="text-[11px] text-[var(--text-faint)]">{meta}</span>}
        {action}
      </div>
    </header>
    <div className={cn('min-w-0', bodyClassName)}>{children}</div>
  </section>
);

export default Panel;
