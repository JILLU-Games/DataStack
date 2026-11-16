import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

type Dot = 'ok' | 'off' | 'pending';
type Item = { label: string; value: ReactNode; dot?: Dot };

const DOT_CLASS: Record<Dot, string> = {
  ok: 'bg-[var(--accent)]',
  off: 'bg-[var(--text-faint)]',
  pending: 'bg-[var(--warning)]',
};

export function StatStrip({ items, className }: { items: Item[]; className?: string }) {
  return (
    <div
      className={cn(
        'stat-strip mb-3 grid w-full grid-cols-2 gap-px border border-[var(--border)] bg-[var(--border)] md:grid-cols-4',
        className
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="min-w-0 bg-[var(--surface)] px-3 py-2">
          <div className="mb-0.5 truncate text-[9.5px] uppercase tracking-wider text-[var(--text-faint)]">
            {item.label}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 font-mono text-[15px] font-medium leading-tight tracking-tight tabular-nums text-[var(--text)]">
            {item.dot && <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 ${DOT_CLASS[item.dot]}`} />}
            <span className="truncate">{item.value}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
