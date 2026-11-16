import type { ReactNode } from 'react';

type Dot = 'ok' | 'off' | 'pending';
type Item = { label: string; value: ReactNode; dot?: Dot };

const DOT_CLASS: Record<Dot, string> = {
  ok: 'bg-[var(--accent)]',
  off: 'bg-[var(--text-faint)]',
  pending: 'bg-[var(--warning)]',
};

export function StatStrip({ items }: { items: Item[] }) {
  return (
    <div className="mb-3 grid grid-cols-2 gap-px border border-[var(--border)] bg-[var(--border)] md:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="bg-[var(--surface)] px-3 py-2">
          <div className="mb-0.5 text-[9.5px] uppercase tracking-wider text-[var(--text-faint)]">
            {item.label}
          </div>
          <div className="flex items-center gap-1.5 font-mono text-[15px] font-medium leading-tight tracking-tight tabular-nums text-[var(--text)]">
            {item.dot && <span aria-hidden="true" className={`h-1.5 w-1.5 ${DOT_CLASS[item.dot]}`} />}
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}
