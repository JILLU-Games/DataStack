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
          className={`mb-[-1px] shrink-0 border-b-2 px-3 py-1.5 text-[11.5px] transition-colors cursor-pointer whitespace-nowrap ${value === item.id ? 'border-[var(--accent)] text-[var(--text)] font-medium' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'}`}
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
    <section className="border-b border-[var(--border)] p-3 last:border-b-0">
      <h2 className="mb-2 flex items-center gap-1.5 text-[9.5px] uppercase tracking-wider text-[var(--text-faint)]">
        {title}
      </h2>
      <div className="flex flex-col gap-1">{children}</div>
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
    <div className="grid grid-cols-1 items-center gap-1.5 py-1.5 sm:grid-cols-[1fr_2fr] sm:gap-4">
      <div className="min-w-0">
        <div className="text-[11.5px] leading-snug text-[var(--text)]">{label}</div>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
