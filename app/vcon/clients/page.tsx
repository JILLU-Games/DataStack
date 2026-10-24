'use client';

import { AdminPageHeader } from '@/components/layout/AdminPageHeader';
import type { ClientItem, ClientStatusFilter } from '@/components/sections/clients/types';
import { ClientsFilters } from '@/components/sections/ClientsFilters';
import { ClientsTable } from '@/components/sections/ClientsTable';
import { NewClientModal } from '@/components/sections/NewClientModal';
import { Button } from '@/components/ui/Button';
import { StatStrip } from '@/components/ui/StatStrip';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

export default function ClientsPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [clients, setClients] = useState<ClientItem[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ClientStatusFilter>('all');
  const [now, setNow] = useState(0);

  const fetchClients = useCallback(async () => {
    const response = await fetch('/api/clients');
    if (!response.ok) throw new Error('Unable to load clients');
    const data = await response.json();
    setClients(data.clients || []);
  }, []);

  useEffect(() => {
    fetchClients().catch(() => setClients([]));
  }, [fetchClients]);

  useEffect(() => {
    const updateClock = () => setNow(Date.now());
    updateClock();
    const interval = setInterval(updateClock, 15_000);
    return () => clearInterval(interval);
  }, []);

  const visibleClients = useMemo(() => {
    const query = search.trim().toLowerCase();
    return clients.filter((client) => {
      const matchesSearch = !query ||
        client.clientId.toLowerCase().includes(query) ||
        client.name.toLowerCase().includes(query);
      const online = client.status === 'active' && Boolean(client.lastActive) &&
        now - new Date(client.lastActive!).getTime() < 60_000;
      const pending = client.status === 'active' && !client.lastActive;
      const matchesStatus = statusFilter === 'all' ||
        (statusFilter === 'online' && online) ||
        (statusFilter === 'offline' && !online && !pending) ||
        (statusFilter === 'pending' && pending);
      return matchesSearch && matchesStatus;
    });
  }, [clients, now, search, statusFilter]);

  const onlineCount = clients.filter((client) =>
    client.status === 'active' && client.lastActive &&
    now - new Date(client.lastActive).getTime() < 60_000
  ).length;
  const pendingCount = clients.filter((client) =>
    client.status === 'active' && !client.lastActive
  ).length;
  const offlineCount = clients.length - onlineCount - pendingCount;

  return (
    <div className="w-full max-w-[var(--console-width)]">
      <div className="mb-3 flex items-center gap-1.5 text-xs text-[var(--text-faint)]" aria-label="Breadcrumb">
        <span>Console</span>
        <span aria-hidden="true" className="text-[var(--border-strong)]">/</span>
        <span aria-current="page" className="text-[var(--text)]">Clients</span>
      </div>
      <AdminPageHeader
        title="Clients"
        subtitle="Registered SDK clients and their API access"
        actions={
          <Button type="button" variant="primary" size="sm" onClick={() => setModalOpen(true)}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            New client
          </Button>
        }
      />

      <StatStrip
        items={[
          { label: 'Total clients', value: clients.length },
          { label: 'Online now', value: onlineCount, dot: 'ok' },
          { label: 'Offline', value: offlineCount, dot: 'off' },
          { label: 'Pending setup', value: pendingCount, dot: 'pending' },
        ]}
      />

      <ClientsFilters
        search={search}
        onSearchChange={setSearch}
        status={statusFilter}
        onStatusChange={setStatusFilter}
        counts={{ all: clients.length, online: onlineCount, offline: offlineCount, pending: pendingCount }}
      />
      <ClientsTable clients={visibleClients} now={now} onStatusChange={fetchClients} />
      <NewClientModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={fetchClients}
      />
    </div>
  );
}
