'use client';

import { Button } from '@/components/ui/Button';
import { ClientList, type ClientListItem } from '@/components/ui/ClientList';
import { Panel } from '@/components/ui/Panel';
import { StatCard } from '@/components/ui/StatCard';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    TableWrap,
} from '@/components/ui/Table';
import Link from 'next/link';
import React, { useCallback, useEffect, useState } from 'react';

type EventItem = {
  eventId: string;
  clientId: string;
  timestamp: string;
  payload: string;
};

type DashboardMetrics = {
  activeClients: number;
  totalClients: number;
  bufferStats: {
    currentBufferSize: number;
    totalFlushed: number;
  };
  storageStats: {
    totalMB: string;
    totalBytes: number;
    totalFiles: number;
    totalRows: number;
  };
};

type StorageFile = {
  clientId: string;
  date: string;
  filename: string;
  sizeBytes: number;
  linesCount: number;
};

export const DashboardOverview: React.FC = () => {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [clients, setClients] = useState<ClientListItem[]>([]);
  const [files, setFiles] = useState<StorageFile[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const [metricsResponse, eventsResponse, storageResponse, clientsResponse] = await Promise.all([
        fetch('/api/metrics', { cache: 'no-store' }),
        fetch('/api/events?limit=8', { cache: 'no-store' }),
        fetch('/api/storage', { cache: 'no-store' }),
        fetch('/api/clients', { cache: 'no-store' }),
      ]);

      if (metricsResponse.ok) setMetrics(await metricsResponse.json());
      if (eventsResponse.ok) {
        const data = await eventsResponse.json();
        setEvents(data.events ?? []);
      }
      if (storageResponse.ok) {
        const data = await storageResponse.json();
        setFiles(data.files ?? []);
      }
      if (clientsResponse.ok) {
        const data = await clientsResponse.json();
        setClients(data.clients ?? []);
      }
    } catch {
      // Keep the last successful dashboard snapshot when one request fails.
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const today = new Date().toISOString().slice(0, 10);
  const storedRecordsToday = files
    .filter((file) => file.date === today)
    .reduce((total, file) => total + file.linesCount, 0);
  const eventsToday = storedRecordsToday + (metrics?.bufferStats.currentBufferSize ?? 0);
  const activeClients = metrics?.activeClients ?? clients.filter((client) => client.status === 'active').length;
  const totalClients = metrics?.totalClients ?? clients.length;
  const totalStorage = metrics?.storageStats.totalMB ?? '0.00';
  const totalStorageBytes = metrics?.storageStats.totalBytes ?? 0;
  const storageValue = totalStorageBytes < 1024 * 1024
    ? String(Math.max(1, Math.round(totalStorageBytes / 1024)))
    : totalStorage;
  const storageUnit = totalStorageBytes < 1024 * 1024 ? 'KB' : 'MB';
  const totalFiles = metrics?.storageStats.totalFiles ?? files.length;
  const totalRows = metrics?.storageStats.totalRows ?? files.reduce((sum, file) => sum + file.linesCount, 0);

  return (
    <section className="flex w-full max-w-[var(--console-width)] flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <nav aria-label="Breadcrumb" className="mb-1 flex items-center gap-2 text-[11px] text-[var(--text-faint)]">
            <span>Console</span>
            <span>/</span>
            <span className="text-[var(--text)]">Dashboard</span>
          </nav>
          <h1 className="text-[17px] font-medium text-[var(--text)]">Dashboard</h1>
          <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">Last 24 hours · UTC</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-2 inline-flex items-center gap-2 text-[10px] uppercase text-[var(--text-muted)]">
            <span className="h-1.5 w-1.5 bg-[var(--accent)]" />
            {metrics ? `${metrics.bufferStats.currentBufferSize} buffered` : 'Connecting'}
          </span>
          <Button
            size="icon"
            variant="secondary"
            icon="RefreshCw"
            aria-label="Refresh dashboard"
            title="Refresh dashboard"
            loading={isRefreshing}
            onClick={() => void refresh()}
          />
          <a href="/api/export?clientId=all" download>
            <Button size="sm" variant="secondary" icon="Download">Quick export</Button>
          </a>
          <Link href="/vcon/clients">
            <Button size="sm" variant="primary" icon="Plus">New client</Button>
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Events today"
          value={eventsToday.toLocaleString()}
          meta={`${metrics?.bufferStats.currentBufferSize ?? 0} waiting in buffer`}
        />
        <StatCard
          label="Active clients"
          value={`${activeClients} / ${totalClients}`}
          meta="registered clients"
        />
        <StatCard
          label="Storage used"
          value={storageValue}
          unit={storageUnit}
          meta="across stored CSV files"
        />
        <StatCard
          label="Stored rows"
          value={totalRows.toLocaleString()}
          meta={`${totalFiles} CSV files`}
        />
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel
          title="Live ingestion"
          meta={`${events.length} recent events`}
          action={<Link href="/vcon/data" className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]">View all →</Link>}
        >
          <TableWrap className="border-0 bg-transparent">
            <Table className="min-w-[600px] text-[11.5px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Payload</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => (
                  <TableRow key={event.eventId}>
                    <TableCell className="font-mono text-[11px] text-[var(--text-faint)]">
                      {event.timestamp.includes('T') ? new Date(event.timestamp).toLocaleTimeString() : event.timestamp}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-[var(--accent)]">
                      {event.clientId}
                    </TableCell>
                    <TableCell className="max-w-[420px] truncate font-mono text-[11px] text-[var(--text)]">
                      {event.payload}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-[var(--text-faint)]">
                      {new TextEncoder().encode(event.payload).length} B
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableWrap>
        </Panel>

        <div className="flex min-w-0 flex-col gap-3">
          <Panel
            title="Recent clients"
            action={<Link href="/vcon/clients" className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]">All →</Link>}
          >
            <ClientList clients={clients} limit={4} />
          </Panel>

          <Panel
            title="Storage"
            meta={`${totalFiles} files`}
            action={<a href="/api/export?clientId=all" download className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]">Quick export ↓</a>}
          >
            <div className="divide-y divide-[var(--border)]">
              {files.slice(0, 3).map((file) => (
                <div key={`${file.clientId}/${file.filename}`} className="flex items-center justify-between gap-3 px-4 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-[12px] text-[var(--text)]">{file.filename}</p>
                    <p className="truncate font-mono text-[10px] text-[var(--text-faint)]">{file.clientId}</p>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
                    {(file.sizeBytes / 1024).toFixed(1)} KB
                  </span>
                </div>
              ))}
              {files.length === 0 && (
                <p className="px-4 py-5 text-[12px] text-[var(--text-faint)]">No CSV files yet.</p>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </section>
  );
};

export default DashboardOverview;
