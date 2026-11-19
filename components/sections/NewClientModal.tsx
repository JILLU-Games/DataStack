'use client';

import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useState } from 'react';
import { CredentialsDisplay } from './ClientsTable';
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
  const [storageQuotaMb, setStorageQuotaMb] = useState('0');
  const [allowedIps, setAllowedIps] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [credentials, setCredentials] = useState<ClientCredentials | null>(null);

  const createClient = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedId = clientId.trim();
    const trimmedName = name.trim();
    if (!trimmedId || !trimmedName) {
      error('Validation error', 'Client ID and Name are required.');
      return;
    }
    const numericRate = Number(rateLimit);
    if (!Number.isInteger(numericRate) || numericRate < 1 || numericRate > 100000) {
      error('Validation error', 'Rate limit must be an integer between 1 and 100,000 events/s.');
      return;
    }
    const numericQuotaMb = Number(storageQuotaMb.trim() === '' ? '0' : storageQuotaMb);
    if (!Number.isInteger(numericQuotaMb) || numericQuotaMb < 0 || numericQuotaMb > 1048576) {
      error('Validation error', 'Storage quota must be an integer between 0 and 1,048,576 MB (0 = unlimited).');
      return;
    }
    let normalizedExpiresAt: string | null = null;
    if (expiresAt.trim()) {
      const parsedDate = new Date(expiresAt.trim());
      if (Number.isNaN(parsedDate.getTime())) {
        error('Validation error', 'Token expiration must be a valid date/time.');
        return;
      }
      normalizedExpiresAt = parsedDate.toISOString();
    }
    setSubmitting(true);
    try {
      const response = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: trimmedId,
          name: trimmedName,
          rateLimit: numericRate,
          storageQuotaMb: numericQuotaMb,
          allowedIps: allowedIps.trim(),
          expiresAt: normalizedExpiresAt,
        }),
      });
      if (response.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Client registration failed');

      setCredentials(data.client as ClientCredentials);
      setClientId('');
      setName('');
      setRateLimit('100');
      setStorageQuotaMb('0');
      setAllowedIps('');
      setExpiresAt('');
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
        title="New client"
        maxWidth="xs"
        footer={
          <>
            <Button type="button" variant="ghost" size="xs" onClick={onClose}>Cancel</Button>
            <Button type="submit" form="new-client-form" variant="primary" size="xs" loading={submitting}>Create</Button>
          </>
        }
      >
        <form id="new-client-form" onSubmit={createClient} className="flex flex-col gap-2.5">
          <Input
            compact
            label="Client ID"
            placeholder="py_order_service_04"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            required
          />
          <Input
            compact
            label="Name"
            placeholder="Order Service"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <Input
            compact
            label="Rate limit (req/s)"
            type="number"
            min="1"
            max="100000"
            value={rateLimit}
            onChange={(event) => setRateLimit(event.target.value)}
          />
          <Input
            compact
            label="Storage quota (MB, 0 = unlimited)"
            type="number"
            min="0"
            max="1048576"
            value={storageQuotaMb}
            onChange={(event) => setStorageQuotaMb(event.target.value)}
          />
          <Input
            compact
            label="Allowed IPs / CIDR (blank = allow all)"
            placeholder="203.0.113.10, 10.0.0.0/8"
            value={allowedIps}
            onChange={(event) => setAllowedIps(event.target.value)}
            className="font-mono text-[11px]"
          />
          <Input
            compact
            label="Token expiration (optional)"
            type="datetime-local"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
            className="font-mono text-[11px]"
          />
        </form>
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
