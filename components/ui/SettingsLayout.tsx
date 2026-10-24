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
    <div className="flex overflow-x-auto border-b border-[var(--border)]" role="tablist" aria-label="Settings categories">
      {items.map((item) => (
        <button
          key={item.id}
          id={`settings-tab-${item.id}`}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          aria-controls={`settings-panel-${item.id}`}
          className={`mb-[-1px] shrink-0 border-b-2 px-3.5 py-2.5 text-xs transition-colors ${value === item.id ? 'border-[var(--accent)] text-[var(--text)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-[var(--border)] p-4 last:border-b-0">
      <h2 className="mb-3 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
        {title}
      </h2>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

export function SettingsField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-1.5 py-2 sm:grid-cols-[1fr_2fr] sm:gap-5">
      <div className="min-w-0 pt-px">
        <div className="text-[12.5px] leading-snug text-[var(--text)]">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-normal text-[var(--text-faint)]">{hint}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
