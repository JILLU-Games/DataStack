'use client';

import { PageShell } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/Button';
import { ClientList, type ClientListItem } from '@/components/ui/ClientList';
import { Panel } from '@/components/ui/Panel';
import { StatStrip } from '@/components/ui/StatStrip';
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from '@/components/ui/Table';
import { getCached, setCached } from '@/lib/vconCache';
import Link from 'next/link';
import React, { useCallback, useEffect, useState } from 'react';

type EventItem = {
  eventId: string;
  clientId: string;
  timestamp: string;
  payload: string;
};

type DashboardMetrics = {
  activeSockets?: number;
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
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(() =>
    getCached<DashboardMetrics | null>('vcon:metrics', null)
  );
  const [events, setEvents] = useState<EventItem[]>(() =>
    getCached<EventItem[]>('vcon:dashboard-events', [])
  );
  const [clients, setClients] = useState<ClientListItem[]>(() =>
    getCached<ClientListItem[]>('vcon:clients', [])
  );
  const [files, setFiles] = useState<StorageFile[]>(() =>
    getCached<StorageFile[]>('vcon:storage-files', [])
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState('');

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const [metricsResponse, eventsResponse, storageResponse, clientsResponse] =
        await Promise.all([
          fetch('/api/metrics', { cache: 'no-store' }),
          fetch('/api/events?limit=8', { cache: 'no-store' }),
          fetch('/api/storage', { cache: 'no-store' }),
          fetch('/api/clients', { cache: 'no-store' }),
        ]);

      if (
        metricsResponse.status === 401 ||
        eventsResponse.status === 401 ||
        storageResponse.status === 401 ||
        clientsResponse.status === 401
      ) {
        window.location.assign('/vcon/login');
        return;
      }

      const errors: string[] = [];

      if (metricsResponse.ok) {
        const nextMetrics = await metricsResponse.json();
        setMetrics(setCached('vcon:metrics', nextMetrics));
      } else {
        errors.push('metrics');
      }

      if (eventsResponse.ok) {
        const data = await eventsResponse.json();
        setEvents(setCached('vcon:dashboard-events', data.events ?? []));
      } else {
        errors.push('events');
      }

      if (storageResponse.ok) {
        const data = await storageResponse.json();
        setFiles(setCached('vcon:storage-files', data.files ?? []));
        if (data.stats) setCached('vcon:storage-stats', data.stats);
      } else {
        errors.push('storage');
      }

      if (clientsResponse.ok) {
        const data = await clientsResponse.json();
        setClients(setCached('vcon:clients', data.clients ?? []));
      } else {
        errors.push('clients');
      }

      if (errors.length > 0) {
        setFetchError(
          `Partial telemetry refresh failed (${errors.join(', ')}). Showing last available snapshot.`
        );
      } else {
        setFetchError('');
      }
    } catch {
      setFetchError(
        'Unable to reach telemetry endpoints. Showing last available snapshot.'
      );
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
  const bufferedCount = metrics?.bufferStats.currentBufferSize ?? 0;
  const eventsToday = storedRecordsToday + bufferedCount;
  const activeClients =
    metrics?.activeClients ??
    clients.filter((client) => client.status === 'active').length;
  const totalClients = metrics?.totalClients ?? clients.length;
  const activeSockets = metrics?.activeSockets ?? 0;
  const totalStorage = metrics?.storageStats.totalMB ?? '0.00';
  const totalStorageBytes = metrics?.storageStats.totalBytes ?? 0;
  const storageValue =
    totalStorageBytes === 0
      ? '0'
      : totalStorageBytes < 1024 * 1024
        ? String(Math.max(1, Math.round(totalStorageBytes / 1024)))
        : totalStorage;
  const storageUnit = totalStorageBytes < 1024 * 1024 ? 'KB' : 'MB';
  const totalFiles = metrics?.storageStats.totalFiles ?? files.length;
  const totalRows =
    metrics?.storageStats.totalRows ??
    files.reduce((sum, file) => sum + file.linesCount, 0);

  return (
    <PageShell
      title="Dashboard"
      actions={
        <>
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
            <Button size="xs" variant="secondary" icon="Download">
              Export
            </Button>
          </a>
          <Link href="/vcon/clients">
            <Button size="xs" variant="primary" icon="Plus">
              New client
            </Button>
          </Link>
        </>
      }
    >
      {fetchError && (
        <div
          role="alert"
          className="mb-3 border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-[11.5px] text-[var(--text)]"
        >
          {fetchError}
        </div>
      )}

      <StatStrip
        items={[
          { label: 'Events today', value: eventsToday.toLocaleString() },
          {
            label: 'Active clients · Sockets',
            value: `${activeClients} / ${totalClients} · ${activeSockets} ws`,
            dot: activeClients > 0 || activeSockets > 0 ? 'ok' : 'off',
          },
          { label: 'Storage used', value: `${storageValue} ${storageUnit}` },
          { label: 'Stored rows', value: totalRows.toLocaleString() },
        ]}
      />

      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)]">
        <Panel
          title="Recent events"
          meta={
            bufferedCount > 0
              ? `${events.length} · ${bufferedCount} buffered`
              : `${events.length}`
          }
          action={
            <Link
              href="/vcon/data"
              className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              View all →
            </Link>
          }
        >
          <TableWrap className="border-0 bg-transparent">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Payload</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.length === 0 ? (
                  <TableEmpty colSpan={4} message="No recent events" />
                ) : (
                  events.map((event) => (
                    <TableRow key={event.eventId}>
                      <TableCell className="font-mono tabular-nums text-[var(--text-faint)]">
                        {event.timestamp.includes('T')
                          ? new Date(event.timestamp).toLocaleTimeString()
                          : event.timestamp}
                      </TableCell>
                      <TableCell className="font-mono text-[var(--accent)]">
                        {event.clientId}
                      </TableCell>
                      <TableCell className="max-w-[380px] truncate font-mono text-[var(--text)]">
                        {event.payload}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums text-[var(--text-faint)]">
                        {new TextEncoder().encode(event.payload).length} B
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableWrap>
        </Panel>

        <div className="flex min-w-0 flex-col gap-3">
          <Panel
            title="Clients"
            action={
              <Link
                href="/vcon/clients"
                className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                All →
              </Link>
            }
          >
            <ClientList clients={clients} limit={4} />
          </Panel>

          <Panel
            title="Storage"
            meta={`${totalFiles}`}
            action={
              <a
                href="/api/export?clientId=all"
                download
                className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                Export ↓
              </a>
            }
          >
            <div className="divide-y divide-[var(--border)]">
              {files.slice(0, 3).map((file) => (
                <div
                  key={`${file.clientId}/${file.filename}`}
                  className="flex items-center justify-between gap-2.5 px-3 py-1.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[11.5px] text-[var(--text)]">
                      {file.filename}
                    </p>
                    <p className="truncate font-mono text-[10px] text-[var(--text-faint)]">
                      {file.clientId}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[var(--text-muted)]">
                    {(file.sizeBytes / 1024).toFixed(1)} KB
                  </span>
                </div>
              ))}
              {files.length === 0 && (
                <p className="px-3 py-4 text-[11px] text-[var(--text-faint)]">
                  No CSV files
                </p>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </PageShell>
  );
};

export default DashboardOverview;
