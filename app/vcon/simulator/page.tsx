'use client';

import { PageShell } from '@/components/layout/PageShell';
import { useVconRole } from '@/components/layout/VconShell';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Select, Textarea } from '@/components/ui/Input';
import { Panel } from '@/components/ui/Panel';
import { Pill } from '@/components/ui/Pill';
import { StatStrip } from '@/components/ui/StatStrip';
import { useToast } from '@/components/ui/Toast';
import { getCached, setCached } from '@/lib/vconCache';
import {
  getVconRoleCapabilities,
  resolvePublicEndpoints,
  shouldRedirectSimulatorUnauthorized,
  summarizeHttpBatchResult,
} from '@/lib/vconUiHelpers';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

interface SimulatorClient {
  clientId: string;
  name: string;
  status: 'active' | 'revoked';
}

type TransportMode = 'http' | 'websocket';
type DispatchStatus = 'Ready' | 'Accepted' | 'Rejected' | 'Error';

function getSocketOrigin(serverPort: number): string {
  return resolvePublicEndpoints(window.location, serverPort).serverUrl;
}

export default function SimulatorPage() {
  const { success, warning, error } = useToast();
  const currentRole = useVconRole();
  const { canOperate } = getVconRoleCapabilities(currentRole);
  const [clients, setClients] = useState<SimulatorClient[]>(() =>
    getCached<SimulatorClient[]>('vcon:clients', [])
  );
  const [selectedClient, setSelectedClient] = useState<string>(() => {
    const cached = getCached<SimulatorClient[]>('vcon:clients', []);
    return cached.find((c) => c.status === 'active')?.clientId ?? cached[0]?.clientId ?? '';
  });
  const [transport, setTransport] = useState<TransportMode>('http');
  const [payloadText, setPayloadText] = useState<string>(
    JSON.stringify(
      {
        event_name: 'sensor_telemetry',
        temperature: 24.8,
        humidity: 58.2,
        voltage: 3.31,
        status: 'NOMINAL',
      },
      null,
      2
    )
  );
  const [serverPort, setServerPort] = useState<number>(() =>
    getCached<number>('vcon:server-port', 4000)
  );
  const [sending, setSending] = useState(false);
  const [dispatchStatus, setDispatchStatus] = useState<DispatchStatus>('Ready');
  const [lastResponse, setLastResponse] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    async function loadSimulatorContext() {
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
          const list = setCached<SimulatorClient[]>('vcon:clients', data.clients || []);
          setClients(list);
          setSelectedClient((prev) => {
            if (prev && list.some((c) => c.clientId === prev)) return prev;
            return list.find((c) => c.status === 'active')?.clientId ?? list[0]?.clientId ?? '';
          });
        }
        if (metricsRes && metricsRes.ok) {
          const metricsData = await metricsRes.json().catch(() => null);
          const runtimePort = Number(metricsData?.runtime?.serverPort);
          if (Number.isFinite(runtimePort) && runtimePort > 0) {
            setServerPort(setCached('vcon:server-port', runtimePort));
          }
        }
      } catch {
        // Ignore transient failure and retain cached list
      }
    }
    void loadSimulatorContext();
  }, []);

  const fetchClientJwt = async (clientId: string): Promise<string> => {
    const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}?includeToken=true`, {
      cache: 'no-store',
    });
    if (res.status === 401) {
      window.location.assign('/vcon/login');
      throw new Error('Authentication required');
    }
    const data = await res.json();
    if (!res.ok || !data?.client?.token) {
      throw new Error(data?.error || 'Unable to retrieve client JWT token');
    }
    return String(data.client.token);
  };

  const emitSocketEvents = async (
    clientId: string,
    items: Array<Record<string, unknown>>
  ): Promise<{ accepted: number; rejected: number; responses: Record<string, unknown>[] }> => {
    const token = await fetchClientJwt(clientId);
    const socketUrl = getSocketOrigin(serverPort);

    return new Promise((resolve, reject) => {
      const socket = io(socketUrl, {
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: false,
        timeout: 4000,
      });

      const timer = window.setTimeout(() => {
        socket.disconnect();
        reject(new Error(`WebSocket timeout (is Port ${serverPort} ingestion server running?)`));
      }, 5000);

      socket.on('connect_error', (connectErr) => {
        window.clearTimeout(timer);
        socket.disconnect();
        reject(new Error(connectErr.message || 'WebSocket authentication failed'));
      });

      socket.on('connect', () => {
        if (items.length === 1) {
          const eventId = `sim_ws_${Date.now()}_0`;
          socket.emit(
            'sync_data',
            {
              clientId,
              eventId,
              timestamp: new Date().toISOString(),
              data: items[0],
            },
            (response: Record<string, unknown>) => {
              window.clearTimeout(timer);
              socket.disconnect();
              const ok = Boolean(response?.success);
              resolve({
                accepted: ok ? 1 : 0,
                rejected: ok ? 0 : 1,
                responses: [response || { success: false, error: 'Empty response' }],
              });
            }
          );
        } else {
          const batchPayload = items.map((data, idx) => ({
            eventId: `sim_ws_${Date.now()}_${idx}`,
            timestamp: new Date().toISOString(),
            data,
          }));
          socket.emit('batch_sync', batchPayload, (response: Record<string, unknown>) => {
            window.clearTimeout(timer);
            socket.disconnect();
            const processed = Number(response?.processed) || 0;
            const rejected = Number(response?.rejected) || 0;
            const ok = Boolean(response?.success);
            resolve({
              accepted: processed,
              rejected: ok && rejected === 0 ? 0 : (rejected || (ok ? 0 : items.length)),
              responses: [response || { success: false, error: 'Empty response' }],
            });
          });
        }
      });
    });
  };

  const handleSendSingle = async () => {
    if (!canOperate) {
      error('Read-only role', 'Event simulation requires operator or owner access.');
      return;
    }
    if (!selectedClient) {
      error('No target client', 'Register a client in /vcon/clients first.');
      return;
    }

    let parsedData: Record<string, unknown>;
    try {
      const raw = JSON.parse(payloadText);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        error('Invalid payload', 'Payload must be a JSON object.');
        return;
      }
      parsedData = raw as Record<string, unknown>;
    } catch {
      error('Invalid JSON', 'Fix payload syntax');
      return;
    }

    setSending(true);
    try {
      if (transport === 'websocket') {
        const result = await emitSocketEvents(selectedClient, [parsedData]);
        const first = result.responses[0] || {};
        setLastResponse({ transport: 'websocket', ...first });
        if (result.accepted > 0) {
          setDispatchStatus('Accepted');
          success('WebSocket Event Accepted', `${String(first.eventId || selectedClient)} acknowledged`);
        } else {
          setDispatchStatus('Rejected');
          error('WebSocket Event Rejected', String(first.message || first.error || 'Rejected by Port 4000'));
        }
        return;
      }

      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: selectedClient,
          data: parsedData,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (
        shouldRedirectSimulatorUnauthorized(
          res.status,
          data && typeof data === 'object' ? (data as Record<string, unknown>) : null,
        )
      ) {
        window.location.assign('/vcon/login');
        return;
      }

      setLastResponse({
        transport: 'http',
        status: res.status,
        ...(data && typeof data === 'object' ? data : {}),
      });

      if (res.ok) {
        setDispatchStatus('Accepted');
        success('Event Accepted', `${data.event?.eventId || selectedClient} buffered`);
      } else {
        setDispatchStatus('Rejected');
        error('Event Rejected', data.error || `Server rejected (HTTP ${res.status})`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Dispatch error';
      setDispatchStatus('Error');
      setLastResponse({ transport, error: message });
      error('Dispatch failed', message);
    } finally {
      setSending(false);
    }
  };

  const handleSendBatch = async (count = 10) => {
    if (!canOperate) {
      error('Read-only role', 'Event simulation requires operator or owner access.');
      return;
    }
    if (!selectedClient) {
      error('No target client', 'Register a client in /vcon/clients first.');
      return;
    }

    const items = Array.from({ length: count }, (_, i) => ({
      batch_index: i + 1,
      sensor: `sensor_${(i % 3) + 1}`,
      reading: +(Math.random() * 100).toFixed(2),
      timestamp: new Date().toISOString(),
    }));

    setSending(true);
    try {
      if (transport === 'websocket') {
        const result = await emitSocketEvents(selectedClient, items);
        setLastResponse({
          transport: 'websocket',
          batchSent: count,
          accepted: result.accepted,
          rejected: result.rejected,
          sample: result.responses.slice(0, 3),
        });
        if (result.accepted === 0) {
          setDispatchStatus('Rejected');
          error('WebSocket Batch Rejected', `0/${count} events ingested`);
        } else if (result.accepted < count) {
          setDispatchStatus('Rejected');
          warning('WebSocket Batch Partial', `${result.accepted}/${count} ingested (${result.rejected} rejected)`);
        } else {
          setDispatchStatus('Accepted');
          success('WebSocket Batch Streamed', `${result.accepted}/${count} ingested`);
        }
        return;
      }

      const batchPayload = items.map((item, idx) => ({
        eventId: `sim_http_${Date.now()}_${idx}`,
        timestamp: item.timestamp,
        data: item,
      }));
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: selectedClient,
          batch: batchPayload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (
        shouldRedirectSimulatorUnauthorized(
          res.status,
          data && typeof data === 'object' ? (data as Record<string, unknown>) : null,
        )
      ) {
        window.location.assign('/vcon/login');
        return;
      }

      const summary = summarizeHttpBatchResult(
        res.ok,
        data && typeof data === 'object' ? (data as Record<string, unknown>) : null,
        count,
      );
      setLastResponse({
        transport: 'http',
        status: res.status,
        batchSent: count,
        accepted: summary.accepted,
        rejected: summary.rejected,
        duplicates: summary.duplicates,
        ...(data && typeof data === 'object' ? data : {}),
      });

      setDispatchStatus(summary.status);
      if (summary.level === 'error') {
        error(summary.title, summary.message);
      } else if (summary.level === 'warning') {
        warning(summary.title, summary.message);
      } else {
        success(summary.title, summary.message);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Batch dispatch error';
      setDispatchStatus('Error');
      setLastResponse({ transport, error: message });
      error('Batch Error', message);
    } finally {
      setSending(false);
    }
  };

  return (
    <PageShell
      title="Simulator"
      actions={
        <>
          <Button
            size="xs"
            variant="secondary"
            loading={sending}
            disabled={!canOperate || sending || !selectedClient}
            title={!canOperate ? 'Requires operator or owner role' : undefined}
            onClick={() => void handleSendBatch(10)}
          >
            Burst 10
          </Button>
          <Button
            size="xs"
            variant="primary"
            icon="Send"
            loading={sending}
            disabled={!canOperate || sending || !selectedClient}
            title={!canOperate ? 'Requires operator or owner role' : undefined}
            onClick={() => void handleSendSingle()}
          >
            Send Event
          </Button>
        </>
      }
    >
      {!canOperate && (
        <div
          role="status"
          className="mb-3 border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2 text-[11.5px] text-[var(--text-muted)]"
        >
          Read-only access (<span className="font-mono text-[var(--text)]">{currentRole}</span>) — dispatching simulated events requires operator or owner permissions.
        </div>
      )}

      {clients.length === 0 && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center justify-between gap-2 border border-[var(--warning)] bg-[var(--warning-soft)] px-3 py-2 text-[11.5px] text-[var(--text)]"
        >
          <span>No registered SDK clients found. Register a client before dispatching events.</span>
          <Link href="/vcon/clients" className="font-medium text-[var(--accent)] underline">
            Go to Clients →
          </Link>
        </div>
      )}

      <StatStrip
        items={[
          {
            label: 'Target client',
            value: selectedClient || 'None selected',
            dot: selectedClient ? 'ok' : 'off',
          },
          {
            label: 'Ingest transport',
            value: transport === 'http' ? 'POST /api/events' : `WS Port ${serverPort}`,
          },
          { label: 'Payload format', value: 'JSON' },
          {
            label: 'Last dispatch',
            value: dispatchStatus,
            dot:
              dispatchStatus === 'Accepted'
                ? 'ok'
                : dispatchStatus === 'Ready'
                  ? undefined
                  : 'off',
          },
        ]}
      />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel title="Payload" bodyClassName="flex flex-col gap-2.5 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
              Transport
            </span>
            <div className="flex gap-1" role="group" aria-label="Ingest transport">
              <Pill
                active={transport === 'http'}
                onClick={() => setTransport('http')}
              >
                HTTP /api/events
              </Pill>
              <Pill
                active={transport === 'websocket'}
                onClick={() => setTransport('websocket')}
              >
                WebSocket Port {serverPort}
              </Pill>
            </div>
          </div>

          <Select
            compact
            label="Target client"
            value={selectedClient}
            disabled={clients.length === 0}
            onChange={(e) => setSelectedClient(e.target.value)}
          >
            {clients.length === 0 ? (
              <option value="">No registered clients</option>
            ) : (
              clients.map((c) => (
                <option key={c.clientId} value={c.clientId}>
                  {c.clientId} ({c.status})
                </option>
              ))
            )}
          </Select>

          <Textarea
            label="Event JSON"
            rows={7}
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            className="font-mono text-[11.5px]"
          />
        </Panel>

        <Panel title="Response" bodyClassName="p-3 font-mono text-[11.5px]">
          {lastResponse ? (
            <CodeBlock className="max-h-[280px] border border-[var(--border)] text-[11px]">
              {JSON.stringify(lastResponse, null, 2)}
            </CodeBlock>
          ) : (
            <div className="border border-dashed border-[var(--border-strong)] p-5 text-center text-[11px] text-[var(--text-dim)]">
              No response
            </div>
          )}
        </Panel>
      </div>
    </PageShell>
  );
}
