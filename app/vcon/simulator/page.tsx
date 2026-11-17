'use client';

import { PageShell } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Select, Textarea } from '@/components/ui/Input';
import { Panel } from '@/components/ui/Panel';
import { Pill } from '@/components/ui/Pill';
import { StatStrip } from '@/components/ui/StatStrip';
import { useToast } from '@/components/ui/Toast';
import { getCached, setCached } from '@/lib/vconCache';
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

function getSocketOrigin(): string {
  const isLocalDev = window.location.port === '3000';
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = isLocalDev ? `${window.location.hostname}:4000` : window.location.host;
  return `${protocol}://${host}`;
}

export default function SimulatorPage() {
  const { success, warning, error } = useToast();
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
  const [sending, setSending] = useState(false);
  const [dispatchStatus, setDispatchStatus] = useState<DispatchStatus>('Ready');
  const [lastResponse, setLastResponse] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    async function loadClients() {
      try {
        const res = await fetch('/api/clients', { cache: 'no-store' });
        if (res.status === 401) {
          window.location.assign('/vcon/login');
          return;
        }
        if (res.ok) {
          const data = await res.json();
          const list = setCached<SimulatorClient[]>('vcon:clients', data.clients || []);
          setClients(list);
          setSelectedClient((prev) => {
            if (prev && list.some((c) => c.clientId === prev)) return prev;
            return list.find((c) => c.status === 'active')?.clientId ?? list[0]?.clientId ?? '';
          });
        }
      } catch {
        // Ignore transient failure and retain cached list
      }
    }
    void loadClients();
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
    const socketUrl = getSocketOrigin();

    return new Promise((resolve, reject) => {
      const socket = io(socketUrl, {
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: false,
        timeout: 4000,
      });

      const timer = window.setTimeout(() => {
        socket.disconnect();
        reject(new Error('WebSocket handshake timed out (is Port 4000 ingestion server running?)'));
      }, 4500);

      socket.on('connect_error', (connectErr) => {
        window.clearTimeout(timer);
        socket.disconnect();
        reject(new Error(connectErr.message || 'WebSocket authentication failed'));
      });

      socket.on('connect', () => {
        const responses: Record<string, unknown>[] = [];
        let accepted = 0;
        let rejected = 0;
        let settled = 0;

        const finishIfDone = () => {
          if (settled >= items.length) {
            window.clearTimeout(timer);
            socket.disconnect();
            resolve({ accepted, rejected, responses });
          }
        };

        const onAck = (ack: Record<string, unknown>) => {
          responses.push(ack);
          if (ack?.status === 'ok' || ack?.status === 'duplicate') {
            accepted++;
          } else {
            rejected++;
          }
          settled++;
          finishIfDone();
        };

        const onErrorEvent = (errPayload: Record<string, unknown>) => {
          responses.push(errPayload);
          rejected++;
          settled++;
          finishIfDone();
        };

        socket.on('ack', onAck);
        socket.on('error_event', onErrorEvent);

        items.forEach((data, index) => {
          const eventId = `sim_ws_${Date.now()}_${index}`;
          socket.emit('telemetry_event', {
            clientId,
            eventId,
            timestamp: new Date().toISOString(),
            data,
          });
        });
      });
    });
  };

  const handleSendSingle = async () => {
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
      if (res.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }

      const data = await res.json();
      setLastResponse({ transport: 'http', status: res.status, ...data });

      if (res.ok) {
        setDispatchStatus('Accepted');
        success('Event Accepted', `${data.event?.eventId || selectedClient} buffered`);
      } else {
        setDispatchStatus('Rejected');
        error('Event Rejected', data.error || 'Server rejected');
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

      let accepted = 0;
      let rejected = 0;
      const errors: string[] = [];

      for (const item of items) {
        const res = await fetch('/api/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: selectedClient,
            data: item,
          }),
        });
        if (res.status === 401) {
          window.location.assign('/vcon/login');
          return;
        }
        if (res.ok) {
          accepted++;
        } else {
          rejected++;
          try {
            const errJson = await res.json();
            if (errJson?.error && errors.length < 3) {
              errors.push(String(errJson.error));
            }
          } catch {
            // ignore non-json error body
          }
        }
      }

      setLastResponse({
        transport: 'http',
        batchSent: count,
        accepted,
        rejected,
        ...(errors.length > 0 ? { errors } : {}),
      });

      if (accepted === 0) {
        setDispatchStatus('Rejected');
        error('Batch Rejected', `0/${count} ingested${errors[0] ? ` (${errors[0]})` : ''}`);
      } else if (accepted < count) {
        setDispatchStatus('Rejected');
        warning('Batch Partial', `${accepted}/${count} ingested (${rejected} rejected)`);
      } else {
        setDispatchStatus('Accepted');
        success('Batch Streamed', `${accepted}/${count} ingested`);
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
            disabled={sending || !selectedClient}
            onClick={() => void handleSendBatch(10)}
          >
            Burst 10
          </Button>
          <Button
            size="xs"
            variant="primary"
            icon="Send"
            loading={sending}
            disabled={sending || !selectedClient}
            onClick={() => void handleSendSingle()}
          >
            Send Event
          </Button>
        </>
      }
    >
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
            value: transport === 'http' ? 'POST /api/events' : 'WS Port 4000',
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
                WebSocket Port 4000
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
