import { cn } from '@/lib/utils';
import Link from 'next/link';
import React from 'react';

interface AdminPageHeaderProps {
  title: string;
  actions?: React.ReactNode;
  className?: string;
}

export function AdminPageHeader({ title, actions, className }: AdminPageHeaderProps) {
  return (
    <header
      className={cn(
        '-mx-3.5 mb-3 flex h-10 shrink-0 items-center border-b border-[var(--border)] bg-[var(--surface)] px-3.5 sm:-mx-5 sm:px-5',
        className
      )}
    >
      <div className="flex w-full max-w-[var(--console-width)] min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Link
            href="/vcon/dashboard"
            className="text-[11.5px] text-[var(--text-faint)] hover:text-[var(--text-muted)]"
          >
            Console
          </Link>
          <span className="text-[11px] text-[var(--border-strong)]" aria-hidden="true">
            /
          </span>
          <h1 className="truncate text-[13px] font-medium tracking-tight text-[var(--text)]">
            {title}
          </h1>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
    </header>
  );
}
