'use client';

import { PageShell } from '@/components/layout/PageShell';
import { useVconRole } from '@/components/layout/VconShell';
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
import { useToast } from '@/components/ui/Toast';
import { getCached, setCached } from '@/lib/vconCache';
import {
  countMatchingBufferedEvents,
  extractContentDispositionFilename,
  formatEventTimeLabel,
  getVconRoleCapabilities,
  isUiClientExpired,
  type BufferedSummary,
} from '@/lib/vconUiHelpers';
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
  expiredClients?: number;
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
  runtime?: {
    ingestionBridgeStatus?: 'online' | 'auth_error' | 'error' | 'offline';
    ingestionBridgeError?: string;
    serverPort?: number;
    webPort?: number;
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
  const { error, info } = useToast();
  const currentRole = useVconRole();
  const { canOperate } = getVconRoleCapabilities(currentRole);
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
  const [bufferedSummary, setBufferedSummary] = useState<BufferedSummary | null>(() =>
    getCached<BufferedSummary | null>('vcon:buffered-summary', null)
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [fetchError, setFetchError] = useState('');

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const [metricsResponse, eventsResponse, storageResponse, clientsResponse] =
        await Promise.all([
          fetch('/api/metrics', { cache: 'no-store' }),
          fetch('/api/events?limit=8&includeBufferedSummary=true', { cache: 'no-store' }),
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
        if (data.bufferedSummary) {
          setBufferedSummary(setCached('vcon:buffered-summary', data.bufferedSummary));
        }
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
  const bufferedTodayRaw = bufferedSummary
    ? countMatchingBufferedEvents(bufferedSummary, {
        clientId: 'all',
        fromDate: today,
        toDate: today,
      }).matchingCount
    : 0;
  const bufferedTodayCount = metrics
    ? Math.min(bufferedTodayRaw, bufferedCount)
    : bufferedTodayRaw;
  const eventsToday = storedRecordsToday + bufferedTodayCount;
  const activeClients =
    metrics?.activeClients ??
    clients.filter(
      (client) =>
        client.status === 'active' &&
        !isUiClientExpired(
          (client as ClientListItem & { expiresAt?: string | null }).expiresAt,
        ),
    ).length;
  const totalClients = metrics?.totalClients ?? clients.length;
  const activeSockets = metrics?.activeSockets ?? 0;
  const bridgeStatus = metrics?.runtime?.ingestionBridgeStatus;
  const bridgeAuthError = bridgeStatus === 'auth_error';
  const socketSuffix =
    bridgeStatus === 'auth_error'
      ? `${activeSockets} ws · auth err`
      : bridgeStatus === 'offline'
        ? `${activeSockets} ws · offline`
        : `${activeSockets} ws`;
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

  const handleQuickExport = async () => {
    setIsExporting(true);
    try {
      const res = await fetch('/api/export?clientId=all', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        error('Export failed', errJson.error || `Export failed with HTTP ${res.status}.`);
        return;
      }
      const blob = await res.blob();
      const filename = extractContentDispositionFilename(
        res.headers.get('content-disposition'),
        `datastack_export_all_${new Date().toISOString().slice(0, 10)}.csv`
      );
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
      info('Export downloaded', `${filename} downloaded.`);
      await refresh();
    } catch (err) {
      error('Export failed', err instanceof Error ? err.message : 'Unable to export dataset.');
    } finally {
      setIsExporting(false);
    }
  };

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
          <Button
            size="xs"
            variant="secondary"
            icon="Download"
            loading={isExporting}
            disabled={isExporting}
            onClick={() => void handleQuickExport()}
          >
            Export
          </Button>
          {canOperate && (
            <Link href="/vcon/clients">
              <Button size="xs" variant="primary" icon="Plus">
                New client
              </Button>
            </Link>
          )}
        </>
      }
    >
      {(fetchError || bridgeAuthError) && (
        <div
          role="alert"
          className="mb-3 border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-[11.5px] text-[var(--text)]"
        >
          {bridgeAuthError
            ? `Ingestion bridge authentication mismatch (${metrics?.runtime?.ingestionBridgeError || '401'}). Check DATASTACK_INTERNAL_SECRET parity.`
            : fetchError}
        </div>
      )}

      <StatStrip
        items={[
          { label: 'Events today', value: eventsToday.toLocaleString() },
          {
            label: 'Active clients · Sockets',
            value: `${activeClients} / ${totalClients} · ${socketSuffix}`,
            dot:
              bridgeAuthError
                ? 'off'
                : activeSockets > 0 || (activeClients > 0 && bridgeStatus === 'online')
                  ? 'ok'
                  : 'off',
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
                        {formatEventTimeLabel(event.timestamp)}
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
              <Link
                href="/vcon/storage"
                className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                Files →
              </Link>
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
