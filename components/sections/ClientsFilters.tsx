'use client';

import { Input } from '@/components/ui/Input';
import { Pill } from '@/components/ui/Pill';
import type { ClientStatusFilter } from './clients/types';

interface ClientsFiltersProps {
  search: string;
  onSearchChange: (value: string) => void;
  status: ClientStatusFilter;
  onStatusChange: (status: ClientStatusFilter) => void;
  counts: Record<ClientStatusFilter, number>;
}

const FILTERS: { key: ClientStatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'online', label: 'Online' },
  { key: 'offline', label: 'Offline' },
  { key: 'pending', label: 'Pending' },
  { key: 'revoked', label: 'Revoked' },
];

export function ClientsFilters({
  search,
  onSearchChange,
  status,
  onStatusChange,
  counts,
}: ClientsFiltersProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      <div className="w-full flex-1 sm:max-w-xs">
        <Input
          compact
          icon="Search"
          type="search"
          aria-label="Search clients"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search client..."
        />
      </div>
      <div className="ml-auto flex min-w-0 gap-1 overflow-x-auto" role="group" aria-label="Filter clients by status">
        {FILTERS.map((filter) => (
          <Pill
            key={filter.key}
            active={status === filter.key}
            onClick={() => onStatusChange(filter.key)}
          >
            {filter.label}
            <span className="font-mono text-[9.5px] tabular-nums text-[var(--text-faint)]">
              {counts[filter.key].toLocaleString()}
            </span>
          </Pill>
        ))}
      </div>
    </div>
  );
}
