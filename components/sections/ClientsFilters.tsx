'use client';

import { Pill } from '@/components/ui/Pill';
import { Search } from 'lucide-react';
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
];

export function ClientsFilters({
  search,
  onSearchChange,
  status,
  onStatusChange,
  counts,
}: ClientsFiltersProps) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="flex h-8 w-full flex-1 items-center gap-1.5 border border-[var(--border)] bg-[var(--surface)] px-2.5 sm:max-w-xs">
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--text-faint)]" aria-hidden="true" />
        <input
          type="search"
          aria-label="Search clients"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search by name or client ID"
          className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
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
            <span className="text-[10px] text-[var(--text-faint)]">
              {counts[filter.key].toLocaleString()}
            </span>
          </Pill>
        ))}
      </div>
    </div>
  );
}
