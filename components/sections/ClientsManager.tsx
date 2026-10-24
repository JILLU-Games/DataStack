'use client';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import {
    Table,
    TableBody,
    TableCell,
    TableEmpty,
    TableHead,
    TableHeader,
    TableRow,
    TableWrap,
} from '@/components/ui/Table';
import { useToast } from '@/components/ui/Toast';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface Client {
  clientId: string;
  name: string;
  rateLimit: number;
  status: 'active' | 'revoked';
  totalEvents: number;
  lastActive?: string;
  createdAt: string;
}

interface ClientCredentials extends Client {
  secret: string;
  token: string;
}

type ClientFilter = 'all' | 'online' | 'offline' | 'pending';

function isOnline(client: Client) {
  return Boolean(
    client.status === 'active' &&
      client.lastActive &&
      Date.now() - new Date(client.lastActive).getTime() < 60_000
  );
}

function isPending(client: Client) {
  return client.status === 'active' && !client.lastActive;
}

function relativeTime(timestamp?: string) {
  if (!timestamp) return 'Never';

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (elapsedSeconds < 10) return 'Just now';
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)}m ago`;
  if (elapsedSeconds < 86_400) return `${Math.floor(elapsedSeconds / 3600)}h ago`;
  return `${Math.floor(elapsedSeconds / 86_400)}d ago`;
}

export function ClientsManager() {
  const { success, error, warning } = useToast();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ClientFilter>('all');
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [credentialsModalOpen, setCredentialsModalOpen] = useState(false);
  const [selectedClient, setSelectedClient] = useState<ClientCredentials | null>(null);
  const [newClientId, setNewClientId] = useState('');
  const [newClientName, setNewClientName] = useState('');
  const [newRateLimit, setNewRateLimit] = useState('100');
  const [submitting, setSubmitting] = useState(false);

  const fetchClients = useCallback(async () => {
    try {
      const response = await fetch('/api/clients');
      if (!response.ok) throw new Error('Unable to load clients');
      const data = await response.json();
      setClients(data.clients || []);
      setLoadError('');
    } catch (fetchError) {
      setLoadError(fetchError instanceof Error ? fetchError.message : 'Unable to load clients');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchClients();
  }, [fetchClients]);

  const onlineCount = clients.filter(isOnline).length;
  const pendingCount = clients.filter(isPending).length;
  const offlineCount = clients.length - onlineCount - pendingCount;
  const eventCount = clients.reduce((sum, client) => sum + client.totalEvents, 0);

  const visibleClients = useMemo(() => {
    const query = search.trim().toLowerCase();

    return clients.filter((client) => {
      const matchesSearch =
        !query ||
        client.clientId.toLowerCase().includes(query) ||
        client.name.toLowerCase().includes(query);
      const matchesFilter =
        filter === 'all' ||
        (filter === 'online' && isOnline(client)) ||
        (filter === 'offline' && !isOnline(client) && !isPending(client)) ||
        (filter === 'pending' && isPending(client));

      return matchesSearch && matchesFilter;
    });
  }, [clients, filter, search]);

  const handleCreateClient = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newClientId.trim() || !newClientName.trim()) {
      error('Validation error', 'Client ID and client name are required.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: newClientId.trim(),
          name: newClientName.trim(),
          rateLimit: Number(newRateLimit) || 100,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Client registration failed');

      setSelectedClient(data.client);
      setCreateModalOpen(false);
      setCredentialsModalOpen(true);
      setNewClientId('');
      setNewClientName('');
      setNewRateLimit('100');
      success('Client registered', `${data.client.clientId} is ready to connect.`);
      await fetchClients();
    } catch (submitError) {
      error('Registration failed', submitError instanceof Error ? submitError.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleStatus = async (client: Client) => {
    const status = client.status === 'active' ? 'revoked' : 'active';
    if (status === 'revoked' && !window.confirm(`Revoke access for ${client.clientId}?`)) return;

    try {
      const response = await fetch(`/api/clients/${encodeURIComponent(client.clientId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to update client status');
      warning('Client status updated', `${client.clientId} is now ${status}.`);
      await fetchClients();
    } catch (updateError) {
      error('Status update failed', updateError instanceof Error ? updateError.message : 'Unknown error');
    }
  };

  const handleRotateKey = async (client: Client) => {
    if (!window.confirm(`Rotate credentials for ${client.clientId}? Existing credentials will stop working.`)) return;

    try {
      const response = await fetch(`/api/clients/${encodeURIComponent(client.clientId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'regenerate_token' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to rotate client credentials');
      setSelectedClient(data.client);
      setCredentialsModalOpen(true);
      success('Credentials rotated', `New credentials issued for ${client.clientId}.`);
      await fetchClients();
    } catch (rotateError) {
      error('Credential rotation failed', rotateError instanceof Error ? rotateError.message : 'Unknown error');
    }
  };

  const copyToClipboard = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      success('Copied', `${label} copied to clipboard.`);
    } catch {
      error('Copy failed', 'Clipboard access is unavailable in this browser.');
    }
  };

  const filters: { id: ClientFilter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: clients.length },
    { id: 'online', label: 'Online', count: onlineCount },
    { id: 'offline', label: 'Offline', count: offlineCount },
    { id: 'pending', label: 'Pending', count: pendingCount },
  ];

  return (
    <section className="mx-auto flex w-full max-w-[var(--container-width)] flex-col gap-4">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-[var(--text-faint)]">
        <span>Console</span>
        <span aria-hidden="true" className="text-[var(--border-strong)]">/</span>
        <span aria-current="page" className="text-[var(--text)]">Clients</span>
      </nav>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-medium tracking-tight text-[var(--text)]">Clients</h1>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">Registered SDK clients and their API access</p>
        </div>
        <Button type="button" variant="primary" size="sm" icon="Plus" onClick={() => setCreateModalOpen(true)}>
          New client
        </Button>
      </header>

      <Card compact className="!p-0">
        <div className="grid grid-cols-2 gap-px bg-[var(--border)] lg:grid-cols-4">
          <StatCell label="Total clients" value={clients.length.toLocaleString()} />
          <StatCell label="Online now" value={onlineCount.toLocaleString()} status="online" />
          <StatCell label="Offline" value={offlineCount.toLocaleString()} status="offline" />
          <StatCell label="Pending setup" value={pendingCount.toLocaleString()} status="pending" />
        </div>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          compact
          aria-label="Search clients"
          placeholder="Search by name or client ID"
          icon="Search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="bg-[var(--surface)] sm:max-w-xs"
        />
        <div className="flex min-w-0 gap-1 overflow-x-auto sm:ml-auto" role="group" aria-label="Filter clients by status">
          {filters.map((item) => (
            <Button
              key={item.id}
              type="button"
              size="xs"
              variant="secondary"
              aria-pressed={filter === item.id}
              className={filter === item.id ? 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text)]' : 'text-[var(--text-muted)]'}
              onClick={() => setFilter(item.id)}
            >
              {item.label}<span className="text-[var(--text-faint)]">{item.count}</span>
            </Button>
          ))}
        </div>
      </div>

      <TableWrap>
        <Table className="min-w-[760px] text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>API key</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Events</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableEmpty colSpan={6} message="Loading clients..." />
            ) : loadError ? (
              <TableEmpty colSpan={6} message={loadError} />
            ) : visibleClients.length === 0 ? (
              <TableEmpty colSpan={6} message={search || filter !== 'all' ? 'No clients match these filters.' : 'No registered SDK clients yet.'} />
            ) : (
              visibleClients.map((client) => (
                <TableRow key={client.clientId}>
                  <TableCell>
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className={`h-1.5 w-1.5 shrink-0 ${client.status === 'active' ? 'bg-[var(--accent)]' : 'bg-[var(--text-faint)]'}`} />
                      <div className="min-w-0">
                        <div className="truncate text-[var(--text)]">{client.name}</div>
                        <div className="truncate font-mono text-[11px] text-[var(--text-faint)]">{client.clientId}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-[var(--text-muted)]" title="Secret keys are hidden. Rotate credentials to issue a new key.">
                    sec_••••••••
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
                      <span className={`h-1.5 w-1.5 ${client.status === 'active' ? 'bg-[var(--accent)]' : 'bg-[var(--text-faint)]'}`} />
                      {client.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-[var(--text)]">
                    {client.totalEvents.toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-[var(--text-muted)]">
                    {relativeTime(client.lastActive)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex items-center gap-1">
                      <Button
                        type="button"
                        variant="icon"
                        size="icon"
                        icon="Activity"
                        className="h-7 w-7 border border-[var(--border)]"
                        title={`View events for ${client.clientId}`}
                        aria-label={`View events for ${client.clientId}`}
                        onClick={() => window.location.assign(`/vcon/data?clientId=${encodeURIComponent(client.clientId)}`)}
                      />
                      <Button
                        type="button"
                        variant="icon"
                        size="icon"
                        icon="RotateCw"
                        className="h-7 w-7 border border-[var(--border)]"
                        title={`Rotate key for ${client.clientId}`}
                        aria-label={`Rotate key for ${client.clientId}`}
                        onClick={() => handleRotateKey(client)}
                      />
                      <Button
                        type="button"
                        variant="icon"
                        size="icon"
                        icon={client.status === 'active' ? 'ShieldOff' : 'ShieldCheck'}
                        className="h-7 w-7 border border-[var(--border)]"
                        title={`${client.status === 'active' ? 'Revoke' : 'Reactivate'} ${client.clientId}`}
                        aria-label={`${client.status === 'active' ? 'Revoke' : 'Reactivate'} ${client.clientId}`}
                        onClick={() => handleToggleStatus(client)}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableWrap>

      <Modal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Create client"
        footer={
          <>
            <Button type="button" variant="ghost" size="sm" onClick={() => setCreateModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" form="create-client-form" variant="primary" size="sm" loading={submitting}>
              Create client
            </Button>
          </>
        }
      >
        <form id="create-client-form" onSubmit={handleCreateClient} className="flex flex-col gap-3">
          <Input
            label="Client ID"
            placeholder="e.g. py_order_service_04"
            value={newClientId}
            onChange={(event) => setNewClientId(event.target.value)}
            required
          />
          <Input
            label="Client name"
            placeholder="e.g. Order Service"
            value={newClientName}
            onChange={(event) => setNewClientName(event.target.value)}
            required
          />
          <Input
            label="Rate limit (requests per second)"
            type="number"
            min="1"
            max="5000"
            value={newRateLimit}
            onChange={(event) => setNewRateLimit(event.target.value)}
          />
        </form>
      </Modal>

      <Modal
        isOpen={credentialsModalOpen}
        onClose={() => setCredentialsModalOpen(false)}
        title={`Credentials: ${selectedClient?.clientId || ''}`}
        description="Copy these credentials now. The secret key is only shown after creation or rotation."
        footer={
          <Button type="button" variant="secondary" size="sm" onClick={() => setCredentialsModalOpen(false)}>
            Close
          </Button>
        }
      >
        {selectedClient && (
          <div className="flex flex-col gap-3">
            <CredentialField
              label="Client ID"
              value={selectedClient.clientId}
              onCopy={() => copyToClipboard(selectedClient.clientId, 'Client ID')}
            />
            <CredentialField
              label="Client secret key"
              value={selectedClient.secret}
              onCopy={() => copyToClipboard(selectedClient.secret, 'Client secret key')}
            />
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="client-token" className="text-xs uppercase text-[var(--text-faint)]">
                  JWT handshake bearer token
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  icon="Copy"
                  onClick={() => copyToClipboard(selectedClient.token, 'JWT token')}
                >
                  Copy
                </Button>
              </div>
              <Textarea id="client-token" readOnly value={selectedClient.token} rows={4} className="font-mono text-xs text-[var(--accent)]" />
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}

function StatCell({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status?: 'online' | 'offline' | 'pending';
}) {
  return (
    <div className="bg-[var(--surface)] px-4 py-3">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--text-faint)]">{label}</div>
      <div className="flex items-center gap-2 text-lg font-medium leading-none tracking-tight text-[var(--text)]">
        {status && (
          <span className={`h-1.5 w-1.5 ${status === 'online' ? 'bg-[var(--accent)]' : 'bg-[var(--text-faint)]'}`} />
        )}
        {value}
      </div>
    </div>
  );
}

function CredentialField({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs uppercase text-[var(--text-faint)]">{label}</label>
      <div className="flex min-w-0 items-center justify-between gap-2 border border-[var(--border)] bg-[var(--bg)] p-2.5">
        <code className="min-w-0 truncate font-mono text-xs text-[var(--text)]">{value}</code>
        <Button type="button" variant="icon" size="icon" icon="Copy" className="h-7 w-7" title={`Copy ${label}`} aria-label={`Copy ${label}`} onClick={onCopy} />
      </div>
    </div>
  );
}
