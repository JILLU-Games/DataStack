import { cn } from '@/lib/utils';
import React from 'react';

export interface SettingsTabItem {
  id: string;
  label: string;
}

export function SettingsTabs({
  items,
  value,
  onChange,
}: {
  items: SettingsTabItem[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div
      className="flex w-full overflow-x-auto overflow-y-hidden border border-b-0 border-[var(--border)] bg-[var(--surface-2)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="tablist"
      aria-label="Settings categories"
    >
      {items.map((item) => (
        <button
          key={item.id}
          id={`settings-tab-${item.id}`}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          aria-controls={`settings-panel-${item.id}`}
          className={`shrink-0 border-b-2 border-r border-r-[var(--border)] px-3.5 py-2 text-[11.5px] transition-colors cursor-pointer whitespace-nowrap ${
            value === item.id
              ? 'border-b-[var(--accent)] bg-[var(--surface)] text-[var(--text)] font-medium'
              : 'border-b-transparent text-[var(--text-muted)] hover:bg-[var(--surface)] hover:text-[var(--text)]'
          }`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsPanel({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'w-full border border-[var(--border)] bg-[var(--surface)]',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function SettingsGroup({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-[var(--border)] p-3.5 last:border-b-0">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[9.5px] font-medium uppercase tracking-wider text-[var(--text-faint)]">
          {title}
        </h2>
        {action && <div className="flex items-center gap-1">{action}</div>}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

export function SettingsField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 items-center gap-1.5 py-1 sm:grid-cols-[220px_minmax(0,520px)] sm:justify-start sm:gap-6">
      <div className="min-w-0">
        <div className="text-[11.5px] leading-snug text-[var(--text)]">{label}</div>
      </div>
      <div className="min-w-0 w-full">{children}</div>
    </div>
  );
}

export function SettingsFooter({
  status,
  children,
}: {
  status?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <footer className="flex w-full flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]" role="status">
        {status}
      </div>
      <div className="flex items-center gap-1.5">{children}</div>
    </footer>
  );
}
