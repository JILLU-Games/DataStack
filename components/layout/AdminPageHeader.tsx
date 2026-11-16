import Link from 'next/link';
import React from 'react';

interface AdminPageHeaderProps {
  title: string;
  actions?: React.ReactNode;
}

export function AdminPageHeader({ title, actions }: AdminPageHeaderProps) {
  return (
    <header className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-2.5">
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
        <h1 className="truncate text-[13.5px] font-medium tracking-tight text-[var(--text)]">
          {title}
        </h1>
      </div>
      {actions && <div className="flex items-center gap-1.5">{actions}</div>}
    </header>
  );
}
