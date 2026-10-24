'use client';

import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { Input, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useState } from 'react';
import type { ClientCredentials } from './clients/types';

interface NewClientModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

export function NewClientModal({ open, onClose, onCreated }: NewClientModalProps) {
  const { success, error } = useToast();
  const [clientId, setClientId] = useState('');
  const [name, setName] = useState('');
  const [rateLimit, setRateLimit] = useState('100');
  const [submitting, setSubmitting] = useState(false);
  const [credentials, setCredentials] = useState<ClientCredentials | null>(null);

  const createClient = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const response = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientId.trim(), name: name.trim(), rateLimit: Number(rateLimit) || 100 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Client registration failed');

      setCredentials(data.client as ClientCredentials);
      setClientId('');
      setName('');
      setRateLimit('100');
      onClose();
      success('Client registered', `${data.client.clientId} is ready to connect.`);
      await onCreated();
    } catch (createError) {
      error('Registration failed', createError instanceof Error ? createError.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Modal
        isOpen={open}
        onClose={onClose}
        title="Create client"
        maxWidth="xs"
        footer={
          <>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" form="new-client-form" variant="primary" size="sm" loading={submitting}>Create client</Button>
          </>
        }
      >
        <form id="new-client-form" onSubmit={createClient} className="flex flex-col gap-3.5">
          <Input
            compact
            label="Client ID"
            placeholder="e.g. py_order_service_04"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            className="h-8 border-[var(--border)] bg-[var(--bg)] px-2.5 text-[12.5px] focus:border-[var(--border-strong)]"
            required
          />
          <Input
            compact
            label="Client name"
            placeholder="e.g. Order Service"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-8 border-[var(--border)] bg-[var(--bg)] px-2.5 text-[12.5px] focus:border-[var(--border-strong)]"
            required
          />
          <Input
            compact
            label="Rate limit (requests per second)"
            type="number"
            min="1"
            max="5000"
            value={rateLimit}
            onChange={(event) => setRateLimit(event.target.value)}
            className="h-8 border-[var(--border)] bg-[var(--bg)] px-2.5 text-[12.5px] focus:border-[var(--border-strong)]"
          />
        </form>
      </Modal>

      <Modal
        isOpen={Boolean(credentials)}
        onClose={() => setCredentials(null)}
        title={`Credentials: ${credentials?.clientId || ''}`}
        description="Copy these credentials now. The secret is only shown after creation."
        footer={<Button type="button" size="sm" onClick={() => setCredentials(null)}>Close</Button>}
      >
        {credentials && (
          <div className="flex flex-col gap-3">
            <Credential label="Client ID" value={credentials.clientId} />
            <Credential label="Client secret key" value={credentials.secret} />
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="new-client-token" className="text-xs uppercase text-[var(--text-faint)]">JWT handshake bearer token</label>
                <CopyButton value={credentials.token} />
              </div>
              <Textarea id="new-client-token" readOnly value={credentials.token} rows={4} className="font-mono text-xs text-[var(--accent)]" />
            </div>
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
        <code className="min-w-0 truncate font-mono text-xs text-[var(--text)]">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}
