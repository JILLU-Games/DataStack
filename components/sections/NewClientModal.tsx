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
    setSubmitting(true);
    try {
      const response = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: trimmedId, name: trimmedName, rateLimit: numericRate }),
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
