'use client';

import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
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
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ClientCredentials, ClientItem } from './clients/types';

interface ClientsTableProps {
  clients: ClientItem[];
  now: number;
  onStatusChange: () => Promise<void>;
}

function relativeTime(timestamp: string | undefined, now: number) {
  if (!timestamp) return 'Never';
  const seconds = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 1000));
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function ClientsTable({ clients, now, onStatusChange }: ClientsTableProps) {
  const router = useRouter();
  const { success, error } = useToast();
  const [credentials, setCredentials] = useState<ClientCredentials | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: 'rotate' | 'revoke' | 'delete';
    client: ClientItem;
  } | null>(null);
  const [purgeFilesOnDelete, setPurgeFilesOnDelete] = useState(false);
  const [editClient, setEditClient] = useState<ClientItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editRateLimit, setEditRateLimit] = useState('100');
  const [editError, setEditError] = useState('');
  const [processing, setProcessing] = useState(false);

  const closeConfirmModal = () => {
    setConfirmAction(null);
    setPurgeFilesOnDelete(false);
  };

  const openEditModal = (client: ClientItem) => {
    setEditClient(client);
    setEditName(client.name);
    setEditRateLimit(String(client.rateLimit || 100));
    setEditError('');
  };

  const executeEditClient = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editClient) return;

    const trimmedName = editName.trim();
    const numericRateLimit = Number(editRateLimit);
    if (!trimmedName) {
      setEditError('Display name is required.');
      return;
    }
    if (!Number.isInteger(numericRateLimit) || numericRateLimit < 1 || numericRateLimit > 100000) {
      setEditError('Rate limit must be an integer between 1 and 100,000 events/s.');
      return;
    }

    setEditError('');
    setProcessing(true);
    try {
      const response = await fetch(`/api/clients/${encodeURIComponent(editClient.clientId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          rateLimit: Math.floor(numericRateLimit),
        }),
      });
      if (response.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to update client');
      success('Client updated', `${editClient.clientId} settings saved.`);
      setEditClient(null);
      await onStatusChange();
    } catch (updateError) {
      error('Client update failed', updateError instanceof Error ? updateError.message : 'Unknown error');
    } finally {
      setProcessing(false);
    }
  };

  const executeRotateKey = async (client: ClientItem) => {
    setProcessing(true);
    try {
      const response = await fetch(`/api/clients/${encodeURIComponent(client.clientId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'regenerate_token' }),
      });
      if (response.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to rotate credentials');
      setConfirmAction(null);
      setCredentials(data.client);
      success('Credentials rotated', `New credentials issued for ${client.clientId}.`);
      await onStatusChange();
    } catch (rotateError) {
      error('Credential rotation failed', rotateError instanceof Error ? rotateError.message : 'Unknown error');
    } finally {
      setProcessing(false);
    }
  };

  const executeStatusChange = async (client: ClientItem, status: 'active' | 'revoked') => {
    setProcessing(true);
    try {
      const response = await fetch(`/api/clients/${encodeURIComponent(client.clientId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (response.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to update client status');
      setConfirmAction(null);
      success('Client status updated', `${client.clientId} is now ${status}.`);
      await onStatusChange();
    } catch (statusError) {
      error('Status update failed', statusError instanceof Error ? statusError.message : 'Unknown error');
    } finally {
      setProcessing(false);
    }
  };

  const executeDeleteClient = async (client: ClientItem, purgeFiles: boolean) => {
    setProcessing(true);
    try {
      const query = purgeFiles ? '?purgeFiles=true' : '';
      const response = await fetch(
        `/api/clients/${encodeURIComponent(client.clientId)}${query}`,
        {
          method: 'DELETE',
        },
      );
      if (response.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to delete client');
      closeConfirmModal();
      const purgedCount = Number(data?.purgedFiles ?? 0);
      success(
        'Client deleted',
        purgeFiles
          ? `${client.clientId} removed and ${purgedCount} stored CSV file${purgedCount === 1 ? '' : 's'} purged.`
          : `${client.clientId} has been permanently removed (stored CSV files retained).`,
      );
      await onStatusChange();
    } catch (deleteError) {
      error('Client deletion failed', deleteError instanceof Error ? deleteError.message : 'Unknown error');
    } finally {
      setProcessing(false);
    }
  };

  const toggleStatus = (client: ClientItem) => {
    if (client.status === 'active') {
      setPurgeFilesOnDelete(false);
      setConfirmAction({ type: 'revoke', client });
    } else {
      void executeStatusChange(client, 'active');
    }
  };

  const handleConfirm = async () => {
    if (!confirmAction) return;
    if (confirmAction.type === 'rotate') {
      await executeRotateKey(confirmAction.client);
    } else if (confirmAction.type === 'delete') {
      await executeDeleteClient(confirmAction.client, purgeFilesOnDelete);
    } else {
      await executeStatusChange(confirmAction.client, 'revoked');
    }
  };

  return (
    <>
      <TableWrap className="border-0 bg-transparent">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>Credentials</TableHead>
              <TableHead className="text-right">Events</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {clients.length === 0 ? (
              <TableEmpty colSpan={5} message="No matching clients" />
            ) : (
              clients.map((client) => {
                const revoked = client.status === 'revoked';
                const online = client.status === 'active' && Boolean(client.lastActive) &&
                  now - new Date(client.lastActive!).getTime() < 60_000;
                const pending = client.status === 'active' && !client.lastActive;
                const label = revoked ? 'revoked' : pending ? 'pending' : online ? 'online' : 'offline';
                const dotClass = revoked
                  ? 'bg-[var(--danger)]'
                  : online
                    ? 'bg-[var(--accent)]'
                    : pending
                      ? 'bg-[var(--warning)]'
                      : 'bg-[var(--text-faint)]';

                return (
                  <TableRow key={client.clientId}>
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={`h-1.5 w-1.5 shrink-0 ${dotClass}`} title={label} />
                        <div className="min-w-0 leading-tight">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-medium text-[var(--text)]">{client.name}</span>
                            {revoked && (
                              <span className="border border-[var(--danger)] bg-[var(--danger-soft)] px-1 py-0 text-[9px] uppercase tracking-wider text-[var(--danger)]">
                                revoked
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 truncate font-mono text-[10.5px] text-[var(--text-faint)]">{client.clientId}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono">
                      <div className="truncate text-[11px] text-[var(--text)]">
                        {client.tokenPreview || 'JWT Active'}
                      </div>
                      <div className="mt-0.5 text-[10px] text-[var(--text-faint)]">
                        {client.rateLimit}/s limit
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {client.totalEvents.toLocaleString()}
                    </TableCell>
                    <TableCell className="font-mono tabular-nums">
                      {client.lastActive ? new Date(client.lastActive).toLocaleTimeString([], { hour12: false }) : '—'}
                      <span className="ml-1.5 font-sans text-[10.5px] text-[var(--text-faint)]">{relativeTime(client.lastActive, now)}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-0.5">
                        <Button
                          type="button"
                          variant="icon"
                          size="icon"
                          icon="Activity"
                          className="h-6 w-6 border border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-2)]"
                          title={`View events for ${client.clientId}`}
                          aria-label={`View events for ${client.clientId}`}
                          onClick={() => router.push(`/vcon/data?clientId=${encodeURIComponent(client.clientId)}`)}
                        />
                        <Button
                          type="button"
                          variant="icon"
                          size="icon"
                          icon="Pencil"
                          className="h-6 w-6 border border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-2)]"
                          title={`Edit ${client.clientId}`}
                          aria-label={`Edit ${client.clientId}`}
                          onClick={() => openEditModal(client)}
                        />
                        <Button
                          type="button"
                          variant="icon"
                          size="icon"
                          icon="RefreshCw"
                          className="h-6 w-6 border border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-2)]"
                          title={`Rotate key for ${client.clientId}`}
                          aria-label={`Rotate key for ${client.clientId}`}
                          onClick={() => setConfirmAction({ type: 'rotate', client })}
                        />
                        <Button
                          type="button"
                          variant="icon"
                          size="icon"
                          icon={client.status === 'active' ? 'ShieldOff' : 'ShieldCheck'}
                          className={`h-6 w-6 border border-transparent ${client.status === 'active' ? 'hover:border-[var(--warning)] hover:text-[var(--warning)]' : 'hover:border-[var(--border)] hover:bg-[var(--surface-2)]'}`}
                          title={`${client.status === 'active' ? 'Revoke' : 'Reactivate'} ${client.clientId}`}
                          aria-label={`${client.status === 'active' ? 'Revoke' : 'Reactivate'} ${client.clientId}`}
                          onClick={() => toggleStatus(client)}
                        />
                        <Button
                          type="button"
                          variant="icon"
                          size="icon"
                          icon="Trash2"
                          className="h-6 w-6 border border-transparent hover:border-[var(--danger)] hover:text-[var(--danger)]"
                          title={`Delete ${client.clientId}`}
                          aria-label={`Delete ${client.clientId}`}
                          onClick={() => {
                            setPurgeFilesOnDelete(false);
                            setConfirmAction({ type: 'delete', client });
                          }}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableWrap>

      <Modal
        isOpen={Boolean(editClient)}
        onClose={() => !processing && setEditClient(null)}
        title={`Edit client: ${editClient?.clientId || ''}`}
        maxWidth="xs"
        footer={
          <>
            <Button type="button" variant="ghost" size="xs" disabled={processing} onClick={() => setEditClient(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="edit-client-form"
              variant="primary"
              size="xs"
              loading={processing}
            >
              Save changes
            </Button>
          </>
        }
      >
        <form id="edit-client-form" onSubmit={executeEditClient} className="flex flex-col gap-2.5">
          <Input
            label="Display name"
            compact
            value={editName}
            onChange={(event) => setEditName(event.target.value)}
            placeholder="Service display name"
            required
          />
          <Input
            label="Rate limit (events/s)"
            compact
            type="number"
            min="1"
            max="100000"
            value={editRateLimit}
            onChange={(event) => setEditRateLimit(event.target.value)}
            required
          />
          {editError && (
            <p role="alert" className="text-[11px] text-[var(--danger)]">
              {editError}
            </p>
          )}
        </form>
      </Modal>

      <Modal
        isOpen={Boolean(confirmAction)}
        onClose={() => !processing && closeConfirmModal()}
        title={
          confirmAction?.type === 'rotate'
            ? 'Rotate credentials'
            : confirmAction?.type === 'delete'
              ? 'Delete client'
              : 'Revoke access'
        }
        maxWidth="xs"
        footer={
          <>
            <Button type="button" variant="ghost" size="xs" disabled={processing} onClick={closeConfirmModal}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={confirmAction?.type === 'rotate' ? 'primary' : 'danger'}
              size="xs"
              loading={processing}
              onClick={handleConfirm}
            >
              {confirmAction?.type === 'rotate'
                ? 'Rotate'
                : confirmAction?.type === 'delete'
                  ? 'Delete'
                  : 'Revoke'}
            </Button>
          </>
        }
      >
        <p className="text-[12px] text-[var(--text-muted)]">
          {confirmAction?.type === 'rotate'
            ? `Rotate credentials for ${confirmAction.client.clientId}? Existing credentials will stop working.`
            : confirmAction?.type === 'delete'
              ? `Permanently delete client ${confirmAction.client.clientId}? This removes the client registration and credentials.`
              : `Revoke access for ${confirmAction?.client.clientId || ''}?`}
        </p>
        {confirmAction?.type === 'delete' && (
          <label className="mt-3 flex cursor-pointer items-start gap-2 border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-[11.5px] text-[var(--text)]">
            <input
              type="checkbox"
              checked={purgeFilesOnDelete}
              onChange={(event) => setPurgeFilesOnDelete(event.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--danger)]"
            />
            <span>
              Also purge stored CSV files for this client
              <span className="mt-0.5 block text-[10.5px] text-[var(--text-faint)]">
                Deletes partitioned disk CSV files along with the client registration.
              </span>
            </span>
          </label>
        )}
      </Modal>

      <Modal
        isOpen={Boolean(credentials)}
        onClose={() => setCredentials(null)}
        title={`Credentials: ${credentials?.clientId || ''}`}
        footer={<Button type="button" size="xs" onClick={() => setCredentials(null)}>Close</Button>}
      >
        {credentials && <CredentialsDisplay credentials={credentials} />}
      </Modal>
    </>
  );
}

export function CredentialsDisplay({ credentials }: { credentials: ClientCredentials }) {
  return (
    <div className="flex flex-col gap-2.5">
      <CredentialItem label="Client ID" value={credentials.clientId} />
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={`token-${credentials.clientId}`} className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
            JWT token
          </label>
          <CopyButton value={credentials.token} />
        </div>
        <Textarea
          id={`token-${credentials.clientId}`}
          readOnly
          value={credentials.token}
          rows={3}
          className="font-mono text-[11px] text-[var(--accent)]"
        />
        <p className="text-[10.5px] text-[var(--text-faint)]">
          Use this signed JWT token for both Socket.IO handshakes and HTTP Bearer ingestion.
        </p>
      </div>
    </div>
  );
}

function CredentialItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">{label}</span>
      <div className="flex min-w-0 items-center justify-between gap-2 border border-[var(--border)] bg-[var(--bg)] p-2">
        <code className="min-w-0 truncate font-mono text-[11px] text-[var(--text)]">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}
