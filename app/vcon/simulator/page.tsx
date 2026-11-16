'use client';

import { AdminPageHeader } from '@/components/layout/AdminPageHeader';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Select, Textarea } from '@/components/ui/Input';
import { Panel } from '@/components/ui/Panel';
import { useToast } from '@/components/ui/Toast';
import { getCached, setCached } from '@/lib/vconCache';
import { useEffect, useState } from 'react';

export default function SimulatorPage() {
  const { success, error } = useToast();
  const [clients, setClients] = useState<any[]>(() => getCached<any[]>('vcon:clients', []));
  const [selectedClient, setSelectedClient] = useState<string>(() => {
    const cached = getCached<any[]>('vcon:clients', []);
    return cached[0]?.clientId ?? '';
  });
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
  const [lastResponse, setLastResponse] = useState<any>(null);

  useEffect(() => {
    async function loadClients() {
      try {
        const res = await fetch('/api/clients');
        if (res.ok) {
          const data = await res.json();
          const list = setCached('vcon:clients', data.clients || []);
          setClients(list);
          if (list.length > 0) setSelectedClient((prev) => prev || list[0].clientId);
        }
      } catch {
        // ignore
      }
    }
    loadClients();
  }, []);

  const handleSendSingle = async () => {
    let parsedData: any;
    try {
      parsedData = JSON.parse(payloadText);
    } catch {
      error('Invalid JSON', 'Fix payload syntax');
      return;
    }

    setSending(true);
    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: selectedClient || 'py_telemetry_agent_01',
          data: parsedData,
        }),
      });

      const data = await res.json();
      setLastResponse(data);

      if (res.ok) {
        success('Event Accepted', `${data.event.eventId} buffered`);
      } else {
        error('Event Rejected', data.error || 'Server rejected');
      }
    } catch (err: any) {
      error('Error', err.message);
    } finally {
      setSending(false);
    }
  };

  const handleSendBatch = async (count = 10) => {
    setSending(true);
    try {
      let accepted = 0;
      for (let i = 0; i < count; i++) {
        const res = await fetch('/api/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: selectedClient || 'py_telemetry_agent_01',
            data: {
              batch_index: i + 1,
              sensor: `sensor_${(i % 3) + 1}`,
              reading: +(Math.random() * 100).toFixed(2),
              timestamp: new Date().toISOString(),
            },
          }),
        });
        if (res.ok) accepted++;
      }
      success('Batch Streamed', `${accepted}/${count} ingested`);
      setLastResponse({ success: true, batchSent: count, accepted });
    } catch (err: any) {
      error('Batch Error', err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="flex w-full flex-col gap-2.5">
      <AdminPageHeader
        title="Simulator"
        actions={
          <>
            <Button
              size="xs"
              variant="secondary"
              loading={sending}
              onClick={() => handleSendBatch(10)}
            >
              Burst 10
            </Button>
            <Button
              size="xs"
              variant="primary"
              icon="Send"
              loading={sending}
              onClick={handleSendSingle}
            >
              Send Event
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
        <Panel title="Payload" bodyClassName="flex flex-col gap-2.5 p-3">
          <Select
            compact
            value={selectedClient}
            onChange={(e) => setSelectedClient(e.target.value)}
          >
            {clients.map((c) => (
              <option key={c.clientId} value={c.clientId}>
                {c.clientId}
              </option>
            ))}
          </Select>

          <Textarea
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
    </section>
  );
}
