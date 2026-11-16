import { cn } from '@/lib/utils';
import React from 'react';
import { AdminPageHeader } from './AdminPageHeader';

interface PageShellProps {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * Single-Source-of-Truth Page Container for all /vcon/* Control Panel views.
 * Guarantees that AdminPageHeader, StatStrip, Panels, Settings forms, and Tables
 * share the exact same full-width container alignment and uniform vertical rhythm.
 */
export function PageShell({
  title,
  actions,
  children,
  className,
}: PageShellProps) {
  return (
    <section className={cn('flex w-full min-w-0 flex-col', className)}>
      <AdminPageHeader title={title} actions={actions} className="mb-0" />
      <div className="flex w-full max-w-[var(--console-width)] min-w-0 flex-col gap-3 pt-3 [&>.stat-strip]:mb-0">
        {children}
      </div>
    </section>
  );
}

export default PageShell;
