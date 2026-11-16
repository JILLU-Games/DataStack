'use client';

import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { Textarea } from '@/components/ui/Input';
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
    type: 'rotate' | 'revoke';
    client: ClientItem;
  } | null>(null);
  const [processing, setProcessing] = useState(false);

  const executeRotateKey = async (client: ClientItem) => {
    setProcessing(true);
    try {
      const response = await fetch(`/api/clients/${encodeURIComponent(client.clientId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'regenerate_token' }),
      });
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

  const toggleStatus = (client: ClientItem) => {
    if (client.status === 'active') {
      setConfirmAction({ type: 'revoke', client });
    } else {
      void executeStatusChange(client, 'active');
    }
  };

  const handleConfirm = async () => {
    if (!confirmAction) return;
    if (confirmAction.type === 'rotate') {
      await executeRotateKey(confirmAction.client);
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
              <TableHead>API key</TableHead>
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
                const online = client.status === 'active' && Boolean(client.lastActive) &&
                  now - new Date(client.lastActive!).getTime() < 60_000;
                const pending = client.status === 'active' && !client.lastActive;
                const label = pending ? 'pending' : online ? 'online' : 'offline';
                const dotClass = online
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
                          <div className="truncate font-medium text-[var(--text)]">{client.name}</div>
                          <div className="mt-0.5 truncate font-mono text-[10.5px] text-[var(--text-faint)]">{client.clientId}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono">
                      sec_••••••••
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
                          icon={client.status === 'active' ? 'Trash2' : 'ShieldCheck'}
                          className={`h-6 w-6 border border-transparent ${client.status === 'active' ? 'hover:border-[var(--danger)] hover:text-[var(--danger)]' : 'hover:border-[var(--border)] hover:bg-[var(--surface-2)]'}`}
                          title={`${client.status === 'active' ? 'Revoke' : 'Reactivate'} ${client.clientId}`}
                          aria-label={`${client.status === 'active' ? 'Revoke' : 'Reactivate'} ${client.clientId}`}
                          onClick={() => toggleStatus(client)}
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
        isOpen={Boolean(confirmAction)}
        onClose={() => !processing && setConfirmAction(null)}
        title={confirmAction?.type === 'rotate' ? 'Rotate credentials' : 'Revoke access'}
        maxWidth="xs"
        footer={
          <>
            <Button type="button" variant="ghost" size="xs" disabled={processing} onClick={() => setConfirmAction(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={confirmAction?.type === 'revoke' ? 'danger' : 'primary'}
              size="xs"
              loading={processing}
              onClick={handleConfirm}
            >
              {confirmAction?.type === 'rotate' ? 'Rotate' : 'Revoke'}
            </Button>
          </>
        }
      >
        <p className="text-[12px] text-[var(--text-muted)]">
          {confirmAction?.type === 'rotate'
            ? `Rotate credentials for ${confirmAction.client.clientId}? Existing credentials will stop working.`
            : `Revoke access for ${confirmAction?.client.clientId || ''}?`}
        </p>
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
      <CredentialItem label="Secret key" value={credentials.secret} />
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
