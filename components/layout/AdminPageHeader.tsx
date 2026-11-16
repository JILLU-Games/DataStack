import React from 'react';

interface AdminPageHeaderProps {
  title: string;
  actions?: React.ReactNode;
}

export function AdminPageHeader({ title, actions }: AdminPageHeaderProps) {
  return (
    <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-[14px] font-medium tracking-tight text-[var(--text)]">{title}</h1>
      {actions && <div className="flex items-center gap-1.5">{actions}</div>}
    </header>
  );
}
