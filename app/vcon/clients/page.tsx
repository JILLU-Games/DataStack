'use client';

import { PageShell } from '@/components/layout/PageShell';
import { useVconRole } from '@/components/layout/VconShell';
import type { ClientItem } from '@/components/sections/clients/types';
import { ClientsTable } from '@/components/sections/ClientsTable';
import { NewClientModal } from '@/components/sections/NewClientModal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Panel } from '@/components/ui/Panel';
import { Pill } from '@/components/ui/Pill';
import { StatStrip } from '@/components/ui/StatStrip';
import { useToast } from '@/components/ui/Toast';
import { getCached, setCached } from '@/lib/vconCache';
import {
  classifyUiClientStatus,
  getVconRoleCapabilities,
  summarizeUiClientCounts,
  type UiClientComputedStatus,
} from '@/lib/vconUiHelpers';
import { useCallback, useEffect, useMemo, useState } from 'react';

type ExtendedClientFilter = 'all' | UiClientComputedStatus;

const CLIENT_FILTER_TABS: { key: ExtendedClientFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'online', label: 'Online' },
  { key: 'offline', label: 'Offline' },
  { key: 'pending', label: 'Pending' },
  { key: 'expired', label: 'Expired' },
  { key: 'revoked', label: 'Revoked' },
];

export default function ClientsPage() {
  const { error } = useToast();
  const currentRole = useVconRole();
  const { canOperate } = getVconRoleCapabilities(currentRole);
  const [modalOpen, setModalOpen] = useState(false);
  const [clients, setClients] = useState<ClientItem[]>(() =>
    getCached<ClientItem[]>('vcon:clients', [])
  );
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ExtendedClientFilter>('all');
  const [now, setNow] = useState(() => Date.now());

  const fetchClients = useCallback(async () => {
    const response = await fetch('/api/clients', { cache: 'no-store' });
    if (response.status === 401) {
      window.location.assign('/vcon/login');
      return;
    }
    if (!response.ok) throw new Error('Unable to load clients');
    const data = await response.json();
    setClients(setCached('vcon:clients', data.clients || []));
  }, []);

  useEffect(() => {
    fetchClients().catch(() => {
      error('Unable to load clients', 'Could not fetch registered clients.');
    });
  }, [error, fetchClients]);

  useEffect(() => {
    const updateClock = () => setNow(Date.now());
    updateClock();
    const interval = setInterval(updateClock, 15_000);
    return () => clearInterval(interval);
  }, []);

  const counts = useMemo(
    () => summarizeUiClientCounts(clients, now),
    [clients, now],
  );

  const visibleClients = useMemo(() => {
    const query = search.trim().toLowerCase();
    return clients.filter((client) => {
      const matchesSearch =
        !query ||
        client.clientId.toLowerCase().includes(query) ||
        client.name.toLowerCase().includes(query);
      const computedStatus = classifyUiClientStatus(client, now);
      const matchesStatus =
        statusFilter === 'all' || computedStatus === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [clients, now, search, statusFilter]);

  const filterCounts: Record<ExtendedClientFilter, number> = {
    all: counts.total,
    online: counts.online,
    offline: counts.offline,
    pending: counts.pending,
    expired: counts.expired,
    revoked: counts.revoked,
  };

  return (
    <PageShell
      title="Clients"
      actions={
        canOperate ? (
          <Button
            type="button"
            variant="primary"
            size="xs"
            icon="Plus"
            onClick={() => setModalOpen(true)}
          >
            New client
          </Button>
        ) : (
          <span className="border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 font-mono text-[10.5px] uppercase tracking-wider text-[var(--text-muted)]">
            Read-only ({currentRole})
          </span>
        )
      }
    >
      <StatStrip
        className="md:grid-cols-6"
        items={[
          { label: 'Total', value: counts.total },
          { label: 'Online', value: counts.online, dot: 'ok' },
          { label: 'Offline', value: counts.offline, dot: 'off' },
          { label: 'Pending', value: counts.pending, dot: 'pending' },
          { label: 'Expired', value: counts.expired, dot: 'off' },
          { label: 'Revoked', value: counts.revoked, dot: 'off' },
        ]}
      />

      <Panel title="Registered clients" meta={`${visibleClients.length}`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <div className="w-full flex-1 sm:max-w-xs">
            <Input
              compact
              icon="Search"
              type="search"
              aria-label="Search clients"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search client..."
            />
          </div>
          <div
            className="ml-auto flex min-w-0 gap-1 overflow-x-auto"
            role="group"
            aria-label="Filter clients by status"
          >
            {CLIENT_FILTER_TABS.map((filter) => (
              <Pill
                key={filter.key}
                active={statusFilter === filter.key}
                onClick={() => setStatusFilter(filter.key)}
              >
                {filter.label}
                <span className="font-mono text-[9.5px] tabular-nums text-[var(--text-faint)]">
                  {filterCounts[filter.key].toLocaleString()}
                </span>
              </Pill>
            ))}
          </div>
        </div>
        <ClientsTable
          clients={visibleClients}
          now={now}
          canManage={canOperate}
          onStatusChange={fetchClients}
        />
      </Panel>

      {canOperate && (
        <NewClientModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onCreated={fetchClients}
        />
      )}
    </PageShell>
  );
}
