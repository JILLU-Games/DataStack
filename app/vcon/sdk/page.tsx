'use client';

import { AdminPageHeader } from '@/components/layout/AdminPageHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Select } from '@/components/ui/Input';
import { Panel } from '@/components/ui/Panel';
import { useToast } from '@/components/ui/Toast';
import { useEffect, useState } from 'react';

export default function SdkGuidePage() {
  const { success } = useToast();
  const [clients, setClients] = useState<any[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>('');

  useEffect(() => {
    async function loadClients() {
      try {
        const res = await fetch('/api/clients');
        if (res.ok) {
          const data = await res.json();
          const list = data.clients || [];
          setClients(list);
          if (list.length > 0) {
            setSelectedClientId(list[0].clientId);
          }
        }
      } catch {
        // ignore
      }
    }
    loadClients();
  }, []);

  const activeClient = clients.find((c) => c.clientId === selectedClientId) || clients[0];
  const sampleToken = activeClient?.token || 'YOUR_SIGNED_CLIENT_JWT_TOKEN';

  const pythonSnippet = `from datastack_sdk import DataStackClient

client = DataStackClient(
    server_url="http://localhost:4000",
    token="${sampleToken}"
)

if client.connect():
    res = client.sync({
        "event_type": "page_view",
        "url": "/products/wireless-headphones",
        "user_id": "usr_9942"
    })
    print("Sync response:", res)

    batch_res = client.batch_sync([
        {"sensor": "temp", "value": 24.5, "unit": "C"},
        {"sensor": "humidity", "value": 61.2, "unit": "%"}
    ])
    print("Batch response:", batch_res)

    client.disconnect()`;

  const copySnippet = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    success('Copied', `${label} copied`);
  };

  return (
    <section className="flex w-full flex-col gap-2.5">
      <AdminPageHeader
        title="Python SDK"
        actions={
          <Button
            size="xs"
            variant="secondary"
            icon="Copy"
            onClick={() => copySnippet(pythonSnippet, 'Snippet')}
          >
            Copy Code
          </Button>
        }
      />

      <Card compact className="flex items-center justify-between bg-[var(--surface)] px-3 py-2 font-mono text-[11.5px]">
        <span className="text-[var(--accent)]">pip install ./sdk-python</span>
        <Button
          size="xs"
          variant="ghost"
          icon="Copy"
          onClick={() => copySnippet('pip install ./sdk-python', 'Pip command')}
        />
      </Card>

      <Panel
        title="Client Snippet"
        action={
          clients.length > 0 ? (
            <div className="w-[170px]">
              <Select
                compact
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
          ) : undefined
        }
      >
        <CodeBlock>{pythonSnippet}</CodeBlock>
      </Panel>
    </section>
  );
}
