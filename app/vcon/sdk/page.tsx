'use client';

import { PageShell } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Select } from '@/components/ui/Input';
import { Panel } from '@/components/ui/Panel';
import { StatStrip } from '@/components/ui/StatStrip';
import { useToast } from '@/components/ui/Toast';
import { getCached, setCached } from '@/lib/vconCache';
import { useEffect, useState } from 'react';

interface SdkClientItem {
  clientId: string;
  name: string;
  status?: 'active' | 'revoked';
  tokenPreview?: string;
  token?: string;
}

export default function SdkGuidePage() {
  const { success, error } = useToast();
  const [clients, setClients] = useState<SdkClientItem[]>(() =>
    getCached<SdkClientItem[]>('vcon:clients', [])
  );
  const [selectedClientId, setSelectedClientId] = useState<string>(() => {
    const cached = getCached<SdkClientItem[]>('vcon:clients', []);
    return cached.find((c) => c.status !== 'revoked')?.clientId ?? cached[0]?.clientId ?? '';
  });
  const [selectedClientToken, setSelectedClientToken] = useState<string>('');
  const [loadingToken, setLoadingToken] = useState<boolean>(false);
  const [serverUrl, setServerUrl] = useState<string>('http://localhost:4000');
  const [apiUrl, setApiUrl] = useState<string>('http://localhost:3000');

  useEffect(() => {
    const isLocalDev = window.location.port === '3000';
    setServerUrl(
      isLocalDev
        ? `${window.location.protocol}//${window.location.hostname}:4000`
        : window.location.origin
    );
    setApiUrl(window.location.origin);

    async function loadClients() {
      try {
        const res = await fetch('/api/clients', { cache: 'no-store' });
        if (res.status === 401) {
          window.location.assign('/vcon/login');
          return;
        }
        if (res.ok) {
          const data = await res.json();
          const list = setCached<SdkClientItem[]>('vcon:clients', data.clients || []);
          setClients(list);
          if (list.length > 0) {
            setSelectedClientId((prev) =>
              list.some((c) => c.clientId === prev)
                ? prev
                : list.find((c) => c.status !== 'revoked')?.clientId ?? list[0].clientId
            );
          }
        }
      } catch {
        // Retain cached list on transient network error
      }
    }
    void loadClients();
  }, []);

  useEffect(() => {
    if (!selectedClientId) {
      setSelectedClientToken('');
      return;
    }

    let cancelled = false;
    setLoadingToken(true);

    async function fetchToken() {
      try {
        const res = await fetch(
          `/api/clients/${encodeURIComponent(selectedClientId)}?includeToken=true`,
          { cache: 'no-store' }
        );
        if (res.status === 401) {
          window.location.assign('/vcon/login');
          return;
        }
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            setSelectedClientToken(String(data?.client?.token || ''));
          }
        } else if (!cancelled) {
          setSelectedClientToken('');
        }
      } catch {
        if (!cancelled) setSelectedClientToken('');
      } finally {
        if (!cancelled) setLoadingToken(false);
      }
    }

    void fetchToken();
    return () => {
      cancelled = true;
    };
  }, [selectedClientId]);

  const activeClient =
    clients.find((c) => c.clientId === selectedClientId) || clients[0];
  const resolvedToken = selectedClientToken || activeClient?.token || '';
  const sampleToken = resolvedToken || 'YOUR_SIGNED_CLIENT_JWT_TOKEN';

  const configSnippet = `# config.datastack.py — Place in your Python project root
DATASTACK_CONFIG = {
    "SERVER_URL": "${serverUrl}",
    "API_URL": "${apiUrl}",
    "CLIENT_TOKEN": "${sampleToken}",
    "CLIENT_ID": "${activeClient?.clientId || ''}",
    "AUTO_CONNECT": True,
    "ENABLE_HTTP_FALLBACK": True,
    "HEARTBEAT_INTERVAL_SEC": 5.0,
    "MAX_RETRIES": 3,
    "BATCH_CHUNK_SIZE": 250,
    "OFFLINE_SPOOL_ENABLED": True,
    "OFFLINE_SPOOL_DIR": ".datastack_spool",
}`;

  const pythonSnippet = `from datastack import DataStack

# Automatically discovers config.datastack.py and connects
client = DataStack()

# 1. Single Event (WebSocket + Auto HTTP Fallback + Offline Spool)
res = client.send({
    "event_type": "page_view",
    "url": "/products/wireless-headphones",
    "user_id": "usr_9942"
})
print("Event response:", res)

# 2. Batch Events
batch_res = client.send_batch([
    {"sensor": "temp", "value": 24.5, "unit": "C"},
    {"sensor": "humidity", "value": 61.2, "unit": "%"}
])
print("Batch response:", batch_res)

# 3. Direct File Ingestion (.csv, .json, .jsonl)
file_res = client.send_file("events_dataset.csv", chunk_size=250)
print("File ingestion:", file_res)

# 4. Inspect Connection & Heartbeat IDLE Status
print("SDK Status:", client.status())

client.disconnect()`;

  const copySnippet = async (text: string, label: string) => {
    try {
      if (!navigator?.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable in this browser context');
      }
      await navigator.clipboard.writeText(text);
      success('Copied', `${label} copied`);
    } catch (copyErr) {
      error(
        'Copy failed',
        copyErr instanceof Error
          ? copyErr.message
          : 'Unable to copy to clipboard. Copy manually from the code block.'
      );
    }
  };

  return (
    <PageShell
      title="Python SDK"
      actions={
        <>
          {resolvedToken && (
            <Button
              size="xs"
              variant="secondary"
              icon="Key"
              disabled={loadingToken}
              onClick={() => void copySnippet(resolvedToken, 'Client JWT token')}
            >
              Copy Token
            </Button>
          )}
          <Button
            size="xs"
            variant="secondary"
            icon="FileCode"
            onClick={() => void copySnippet(configSnippet, 'config.datastack.py')}
          >
            Copy Config
          </Button>
          <Button
            size="xs"
            variant="secondary"
            icon="Copy"
            onClick={() => void copySnippet(pythonSnippet, 'Python SDK snippet')}
          >
            Copy Code
          </Button>
        </>
      }
    >
      <StatStrip
        items={[
          { label: 'SDK package', value: 'datastack (v2.2.0)', dot: 'ok' },
          { label: 'Transport', value: 'WS + HTTP Fallback + Offline Spool' },
          { label: 'Server endpoint', value: serverUrl },
          {
            label: 'Active client',
            value: activeClient?.clientId || 'None selected',
          },
        ]}
      />

      <Card
        compact
        className="flex w-full items-center justify-between bg-[var(--surface)] px-3 py-2 font-mono text-[11.5px]"
      >
        <span className="text-[var(--accent)]">
          pip install ./sdk/python/datastack
        </span>
        <Button
          size="xs"
          variant="ghost"
          icon="Copy"
          aria-label="Copy pip install command"
          onClick={() =>
            void copySnippet('pip install ./sdk/python/datastack', 'Pip command')
          }
        />
      </Card>

      <Panel
        title="Step 1 — config.datastack.py"
        className="w-full"
        action={
          <div className="flex items-center gap-2">
            {clients.length > 0 && (
              <div className="w-[190px]">
                <Select
                  compact
                  aria-label="Select SDK client"
                  value={selectedClientId}
                  onChange={(e) => setSelectedClientId(e.target.value)}
                >
                  {clients.map((c) => (
                    <option key={c.clientId} value={c.clientId}>
                      {c.clientId}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <Button
              size="xs"
              variant="ghost"
              icon="Copy"
              aria-label="Copy config.datastack.py"
              onClick={() => void copySnippet(configSnippet, 'config.datastack.py')}
            />
          </div>
        }
      >
        <CodeBlock>{configSnippet}</CodeBlock>
      </Panel>

      <Panel
        title="Step 2 — Application Usage (Events, Batches & Direct CSV/JSON Files)"
        className="w-full"
        action={
          <Button
            size="xs"
            variant="ghost"
            icon="Copy"
            aria-label="Copy Python SDK snippet"
            onClick={() => void copySnippet(pythonSnippet, 'Python SDK snippet')}
          />
        }
      >
        <CodeBlock>{pythonSnippet}</CodeBlock>
      </Panel>
    </PageShell>
  );
}
