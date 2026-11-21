'use client';

import { PageShell } from '@/components/layout/PageShell';
import { useVconRole } from '@/components/layout/VconShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Select } from '@/components/ui/Input';
import { Panel } from '@/components/ui/Panel';
import { StatStrip } from '@/components/ui/StatStrip';
import { useToast } from '@/components/ui/Toast';
import { getCached, setCached } from '@/lib/vconCache';
import {
  getVconRoleCapabilities,
  resolvePublicEndpoints,
} from '@/lib/vconUiHelpers';
import { useEffect, useState } from 'react';

interface SdkClientItem {
  clientId: string;
  name: string;
  status?: 'active' | 'revoked';
  tokenPreview?: string;
  token?: string;
}

type SdkLanguageTab = 'python' | 'node' | 'curl';

export default function SdkGuidePage() {
  const { success, error } = useToast();
  const shellRole = useVconRole();
  const { canOperate } = getVconRoleCapabilities(shellRole);
  const [activeTab, setActiveTab] = useState<SdkLanguageTab>('python');
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
    const initialPort = getCached<number>('vcon:server-port', 4000);
    const initialEndpoints = resolvePublicEndpoints(window.location, initialPort);
    setServerUrl(initialEndpoints.serverUrl);
    setApiUrl(initialEndpoints.apiUrl);

    async function loadSdkContext() {
      try {
        const [clientsRes, metricsRes] = await Promise.all([
          fetch('/api/clients', { cache: 'no-store' }),
          fetch('/api/metrics', { cache: 'no-store' }).catch(() => null),
        ]);
        if (clientsRes.status === 401 || metricsRes?.status === 401) {
          window.location.assign('/vcon/login');
          return;
        }
        if (clientsRes.ok) {
          const data = await clientsRes.json();
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
        if (metricsRes && metricsRes.ok) {
          const metricsData = await metricsRes.json().catch(() => null);
          const runtimePort = Number(metricsData?.runtime?.serverPort);
          if (Number.isFinite(runtimePort) && runtimePort > 0) {
            setCached('vcon:server-port', runtimePort);
            const resolved = resolvePublicEndpoints(window.location, runtimePort);
            setServerUrl(resolved.serverUrl);
            setApiUrl(resolved.apiUrl);
          }
        }
      } catch {
        // Retain cached list on transient network error
      }
    }
    void loadSdkContext();
  }, []);

  useEffect(() => {
    if (!selectedClientId || !canOperate) {
      setSelectedClientToken('');
      setLoadingToken(false);
      return;
    }

    let cancelled = false;
    setSelectedClientToken('');
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
  }, [selectedClientId, canOperate]);

  const activeClient =
    clients.find((c) => c.clientId === selectedClientId) || clients[0];
  const resolvedToken = loadingToken
    ? ''
    : selectedClientToken || activeClient?.token || '';
  const sampleToken = loadingToken
    ? 'LOADING_CLIENT_JWT_TOKEN...'
    : resolvedToken || 'YOUR_SIGNED_CLIENT_JWT_TOKEN';
  const clientIdValue = activeClient?.clientId || '';

  const pythonConfigSnippet = `# config.datastack.py — Place in your Python project root
DATASTACK_CONFIG = {
    "SERVER_URL": "${serverUrl}",
    "API_URL": "${apiUrl}",
    "CLIENT_TOKEN": "${sampleToken}",
    "CLIENT_ID": "${clientIdValue}",
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

  const nodeConfigSnippet = `// datastack.config.json — Place in your Node.js / TypeScript project root
{
  "serverUrl": "${serverUrl}",
  "apiUrl": "${apiUrl}",
  "clientToken": "${sampleToken}",
  "clientId": "${clientIdValue}",
  "autoConnect": true,
  "enableHttpFallback": true,
  "heartbeatIntervalMs": 5000,
  "maxRetries": 3,
  "batchChunkSize": 250,
  "offlineSpoolEnabled": true,
  "offlineSpoolDir": ".datastack_spool"
}`;

  const nodeSnippet = `import { DataStack } from '@datastack/sdk';

// Loads datastack.config.json or explicit constructor options
const client = new DataStack({
  serverUrl: '${serverUrl}',
  apiUrl: '${apiUrl}',
  token: '${sampleToken}',
  clientId: '${clientIdValue}',
  autoConnect: true,
});

// 1. Single Event (Socket.IO Primary + Auto HTTP Fallback + Offline Spool)
const res = await client.send({
  event_type: 'checkout_completed',
  order_id: 'ord_9942',
  amount_usd: 149.5,
});
console.log('Event response:', res);

// 2. Batch Events (Auto-chunked & 413/429 resilient)
const batchRes = await client.sendBatch([
  { sensor: 'temp', value: 24.5, unit: 'C' },
  { sensor: 'humidity', value: 61.2, unit: '%' },
]);
console.log('Batch response:', batchRes);

// 3. Direct File Ingestion (.csv, .json, .jsonl, .ndjson with SHA-256 deterministic eventId)
const fileRes = await client.sendFile('./events_dataset.csv', { chunkSize: 250 });
console.log('File ingestion:', fileRes);

// 4. Graceful Shutdown Drain (awaits in-flight + drains offline spool)
await client.shutdown(5000);`;

  const curlConfigSnippet = `# Environment exports for HTTP / cURL ingestion
export DATASTACK_API_URL="${apiUrl}"
export DATASTACK_CLIENT_ID="${clientIdValue}"
export DATASTACK_CLIENT_TOKEN="${sampleToken}"`;

  const curlSnippet = `# 1. Single Event Ingestion via HTTP POST /api/events
curl -X POST "${apiUrl}/api/events" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${sampleToken}" \\
  -d '{
    "clientId": "${clientIdValue}",
    "data": {
      "event_type": "deployment_finished",
      "service": "billing-api",
      "status": "healthy"
    }
  }'

# 2. Batch Event Ingestion via HTTP POST /api/events
curl -X POST "${apiUrl}/api/events" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${sampleToken}" \\
  -d '{
    "clientId": "${clientIdValue}",
    "batch": [
      { "data": { "metric": "cpu_pct", "value": 31.4 } },
      { "data": { "metric": "mem_pct", "value": 58.2 } }
    ]
  }'`;

  const activeConfigSnippet =
    activeTab === 'node'
      ? nodeConfigSnippet
      : activeTab === 'curl'
        ? curlConfigSnippet
        : pythonConfigSnippet;
  const activeCodeSnippet =
    activeTab === 'node'
      ? nodeSnippet
      : activeTab === 'curl'
        ? curlSnippet
        : pythonSnippet;
  const activeConfigLabel =
    activeTab === 'node'
      ? 'datastack.config.json'
      : activeTab === 'curl'
        ? 'Environment Variables'
        : 'config.datastack.py';
  const activeCodeLabel =
    activeTab === 'node'
      ? 'Node.js / TypeScript SDK snippet'
      : activeTab === 'curl'
        ? 'cURL REST snippet'
        : 'Python SDK snippet';

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
      title="Client SDKs (Python & Node.js / TypeScript)"
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
            disabled={loadingToken}
            onClick={() => void copySnippet(activeConfigSnippet, activeConfigLabel)}
          >
            Copy Config
          </Button>
          <Button
            size="xs"
            variant="secondary"
            icon="Copy"
            onClick={() => void copySnippet(activeCodeSnippet, activeCodeLabel)}
          >
            Copy Code
          </Button>
        </>
      }
    >
      <StatStrip
        items={[
          {
            label: 'SDK packages',
            value:
              activeTab === 'node'
                ? '@datastack/sdk (v2.2.0)'
                : activeTab === 'curl'
                  ? 'REST HTTP/1.1 & HTTP/2'
                  : 'datastack (v2.2.0)',
            dot: 'ok',
          },
          { label: 'Transport', value: 'WS + HTTP Fallback + Offline Spool' },
          { label: 'Server endpoint', value: serverUrl },
          {
            label: 'Active client',
            value: activeClient
              ? activeClient.status === 'revoked'
                ? `${activeClient.clientId} (revoked)`
                : activeClient.clientId
              : 'None selected',
            dot: activeClient?.status === 'revoked' ? 'off' : activeClient ? 'ok' : undefined,
          },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
        <div className="flex items-center gap-1.5" role="tablist" aria-label="SDK Language Selector">
          <Button
            size="xs"
            variant={activeTab === 'python' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('python')}
          >
            Python SDK (v2.2.0)
          </Button>
          <Button
            size="xs"
            variant={activeTab === 'node' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('node')}
          >
            Node.js / TypeScript SDK (v2.2.0)
          </Button>
          <Button
            size="xs"
            variant={activeTab === 'curl' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('curl')}
          >
            HTTP / cURL
          </Button>
        </div>
        <span className="font-mono text-[10.5px] text-[var(--text-faint)]">
          {activeTab === 'node'
            ? 'sdk/node/datastack'
            : activeTab === 'curl'
              ? 'POST /api/events'
              : 'sdk/python/datastack'}
        </span>
      </div>

      {activeTab === 'python' && (
        <Card
          compact
          className="flex w-full flex-col gap-1.5 bg-[var(--surface)] px-3 py-2.5"
        >
          <div className="flex items-center justify-between gap-2 font-mono text-[11.5px]">
            <span className="truncate text-[var(--accent)]">
              pip install /path/to/datastack/sdk/python/datastack
            </span>
            <Button
              size="xs"
              variant="ghost"
              icon="Copy"
              aria-label="Copy pip install command"
              onClick={() =>
                void copySnippet(
                  'pip install /path/to/datastack/sdk/python/datastack',
                  'Pip command'
                )
              }
            />
          </div>
          <p className="text-[11px] text-[var(--text-faint)]">
            Self-hosted package bundled in <code className="font-mono text-[var(--text-muted)]">sdk/python/datastack</code>. From inside the repo run{' '}
            <code className="font-mono text-[var(--text-muted)]">pip install ./sdk/python/datastack</code>, or build a portable wheel with{' '}
            <code className="font-mono text-[var(--text-muted)]">pip wheel ./sdk/python/datastack -w dist/</code> for external projects.
          </p>
        </Card>
      )}

      {activeTab === 'node' && (
        <Card
          compact
          className="flex w-full flex-col gap-1.5 bg-[var(--surface)] px-3 py-2.5"
        >
          <div className="flex items-center justify-between gap-2 font-mono text-[11.5px]">
            <span className="truncate text-[var(--accent)]">
              npm install /path/to/datastack/sdk/node/datastack
            </span>
            <Button
              size="xs"
              variant="ghost"
              icon="Copy"
              aria-label="Copy npm install command"
              onClick={() =>
                void copySnippet(
                  'npm install /path/to/datastack/sdk/node/datastack',
                  'NPM command'
                )
              }
            />
          </div>
          <p className="text-[11px] text-[var(--text-faint)]">
            Official Node.js &amp; TypeScript package bundled in{' '}
            <code className="font-mono text-[var(--text-muted)]">sdk/node/datastack</code> (Node &gt;= 20). Supports Socket.IO primary streaming, automatic{' '}
            <code className="font-mono text-[var(--text-muted)]">POST /api/events</code> fallback, deterministic{' '}
            <code className="font-mono text-[var(--text-muted)]">sendFile()</code> SHA-256 deduplication, offline disk spooling, and graceful{' '}
            <code className="font-mono text-[var(--text-muted)]">await client.shutdown()</code>.
          </p>
        </Card>
      )}

      {!canOperate && (
        <div
          role="status"
          data-testid="sdk-viewer-rbac-banner"
          className="mb-3 border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-[11.5px] text-[var(--text)]"
        >
          Read-only <span className="font-mono uppercase">{shellRole}</span> session:
          Operator or Owner role required to reveal live client JWT tokens. Snippets below
          safely use placeholder{' '}
          <code className="font-mono text-[var(--accent)]">
            YOUR_SIGNED_CLIENT_JWT_TOKEN
          </code>
          .
        </div>
      )}

      <Panel
        title={`Step 1 — ${activeConfigLabel}`}
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
              aria-label={`Copy ${activeConfigLabel}`}
              disabled={loadingToken}
              onClick={() => void copySnippet(activeConfigSnippet, activeConfigLabel)}
            />
          </div>
        }
      >
        <CodeBlock>{activeConfigSnippet}</CodeBlock>
      </Panel>

      <Panel
        title="Step 2 — Application Usage (Events, Batches & Direct CSV/JSON Files)"
        className="w-full"
        action={
          <Button
            size="xs"
            variant="ghost"
            icon="Copy"
            aria-label={`Copy ${activeCodeLabel}`}
            onClick={() => void copySnippet(activeCodeSnippet, activeCodeLabel)}
          />
        }
      >
        <CodeBlock>{activeCodeSnippet}</CodeBlock>
      </Panel>
    </PageShell>
  );
}
