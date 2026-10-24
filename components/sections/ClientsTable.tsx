'use client';

import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
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
  const { success, error } = useToast();
  const [credentials, setCredentials] = useState<ClientCredentials | null>(null);

  const rotateKey = async (client: ClientItem) => {
    if (!window.confirm(`Rotate credentials for ${client.clientId}? Existing credentials will stop working.`)) return;
    try {
      const response = await fetch(`/api/clients/${encodeURIComponent(client.clientId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'regenerate_token' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to rotate credentials');
      setCredentials(data.client);
      success('Credentials rotated', `New credentials issued for ${client.clientId}.`);
      await onStatusChange();
    } catch (rotateError) {
      error('Credential rotation failed', rotateError instanceof Error ? rotateError.message : 'Unknown error');
    }
  };

  const toggleStatus = async (client: ClientItem) => {
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
      success('Client status updated', `${client.clientId} is now ${status}.`);
      await onStatusChange();
    } catch (statusError) {
      error('Status update failed', statusError instanceof Error ? statusError.message : 'Unknown error');
    }
  };

  return (
    <>
      <TableWrap>
        <Table className="min-w-[760px] text-xs">
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
              <TableEmpty colSpan={5} message="No clients match these filters." />
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
                  <TableRow key={client.clientId} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--surface-2)]">
                    <TableCell className="px-3.5 py-2.5">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className={`h-1.5 w-1.5 shrink-0 ${dotClass}`} title={label} />
                        <div className="min-w-0 leading-tight">
                          <div className="truncate text-[12.5px] text-[var(--text)]">{client.name}</div>
                          <div className="mt-0.5 truncate font-mono text-[10.5px] text-[var(--text-faint)]">{client.clientId}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="px-3.5 py-2.5 font-mono text-[11.5px] text-[var(--text-muted)]" title="Secret keys are hidden. Rotate credentials to issue a new key.">
                      sec_••••••••
                    </TableCell>
                    <TableCell className="px-3.5 py-2.5 text-right font-mono text-[11.5px] text-[var(--text-muted)]">
                      {client.totalEvents.toLocaleString()}
                    </TableCell>
                    <TableCell className="px-3.5 py-2.5 font-mono text-[11.5px] text-[var(--text-muted)]">
                      {client.lastActive ? new Date(client.lastActive).toLocaleTimeString([], { hour12: false }) : '—'}
                      <span className="ml-1 font-sans text-[10.5px] text-[var(--text-faint)]">{relativeTime(client.lastActive, now)}</span>
                    </TableCell>
                    <TableCell className="px-3.5 py-2.5 text-right">
                      <div className="inline-flex gap-0.5">
                        <Button
                          type="button"
                          variant="icon"
                          size="icon"
                          icon="Activity"
                          className="h-[26px] w-[26px] border border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-2)]"
                          title={`View events for ${client.clientId}`}
                          aria-label={`View events for ${client.clientId}`}
                          onClick={() => window.location.assign(`/vcon/data?clientId=${encodeURIComponent(client.clientId)}`)}
                        />
                        <Button
                          type="button"
                          variant="icon"
                          size="icon"
                          icon="RefreshCw"
                          className="h-[26px] w-[26px] border border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-2)]"
                          title={`Rotate key for ${client.clientId}`}
                          aria-label={`Rotate key for ${client.clientId}`}
                          onClick={() => rotateKey(client)}
                        />
                        <Button
                          type="button"
                          variant="icon"
                          size="icon"
                          icon={client.status === 'active' ? 'Trash2' : 'ShieldCheck'}
                          className={`h-[26px] w-[26px] border border-transparent ${client.status === 'active' ? 'hover:border-[var(--danger)] hover:text-[var(--danger)]' : 'hover:border-[var(--border)] hover:bg-[var(--surface-2)]'}`}
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
        isOpen={Boolean(credentials)}
        onClose={() => setCredentials(null)}
        title={`Credentials: ${credentials?.clientId || ''}`}
        description="Copy the new credentials now. The secret is only shown after rotation."
        footer={<Button type="button" size="sm" onClick={() => setCredentials(null)}>Close</Button>}
      >
        {credentials && (
          <div className="flex flex-col gap-3">
            <Credential label="Client ID" value={credentials.clientId} />
            <Credential label="Client secret key" value={credentials.secret} />
            <Credential label="JWT token" value={credentials.token} />
          </div>
        )}
      </Modal>
    </>
  );
}

function Credential({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs uppercase text-[var(--text-faint)]">{label}</span>
      <div className="flex min-w-0 items-center justify-between gap-2 border border-[var(--border)] bg-[var(--bg)] p-2.5">
        <code className="min-w-0 break-all font-mono text-xs text-[var(--text)]">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}
