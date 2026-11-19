'use client';

import { PageShell } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Panel } from '@/components/ui/Panel';
import { Pill } from '@/components/ui/Pill';
import { StatStrip } from '@/components/ui/StatStrip';
import { useToast } from '@/components/ui/Toast';
import { getCached, setCached } from '@/lib/vconCache';
import {
  countMatchingBufferedEvents,
  extractContentDispositionFilename,
  getUtcDateRangeForPreset,
  matchesSelectedClientFolder,
  type BufferedSummary,
} from '@/lib/vconUiHelpers';
import { Braces, FileText } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface Client {
  clientId: string;
  name: string;
}

interface StorageFile {
  clientId: string;
  date: string;
  filename: string;
  sizeBytes: number;
  linesCount: number;
  modifiedAt: string;
}

type ExportFormat = 'csv' | 'json' | 'ndjson';
type RangePreset = 'today' | '7d' | '30d' | 'all' | 'custom';

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function relativeTime(value: string, now: number) {
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return '—';
  const elapsedSeconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)}m ago`;
  if (elapsedSeconds < 86_400) return `${Math.floor(elapsedSeconds / 3600)}h ago`;
  return `${Math.floor(elapsedSeconds / 86_400)}d ago`;
}

export function ExportWorkspace() {
  const { error, info } = useToast();
  const [clients, setClients] = useState<Client[]>(() =>
    getCached<Client[]>('vcon:clients', [])
  );
  const [files, setFiles] = useState<StorageFile[]>(() =>
    getCached<StorageFile[]>('vcon:storage-files', [])
  );
  const [bufferedCount, setBufferedCount] = useState<number>(0);
  const [bufferedSummary, setBufferedSummary] = useState<BufferedSummary | null>(null);
  const [selectedClient, setSelectedClient] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [preset, setPreset] = useState<RangePreset>('all');
  const [loading, setLoading] = useState(
    () => getCached<StorageFile[]>('vcon:storage-files', []).length === 0
  );
  const [downloading, setDownloading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const refreshExportData = useCallback(async () => {
    try {
      const [clientData, storageData, metricsData, bufferedData] = await Promise.all([
        fetch('/api/clients', { cache: 'no-store' }).then(async (response) => {
          if (response.status === 401) {
            window.location.assign('/vcon/login');
            return { clients: [] };
          }
          if (!response.ok) throw new Error('Unable to load clients');
          return response.json();
        }),
        fetch('/api/storage', { cache: 'no-store' }).then(async (response) => {
          if (response.status === 401) {
            window.location.assign('/vcon/login');
            return { files: [] };
          }
          if (!response.ok) throw new Error('Unable to load stored files');
          return response.json();
        }),
        fetch('/api/metrics', { cache: 'no-store' })
          .then(async (response) => (response.ok ? response.json() : null))
          .catch(() => null),
        fetch('/api/events?bufferedOnly=true&limit=1', { cache: 'no-store' })
          .then(async (response) => (response.ok ? response.json() : null))
          .catch(() => null),
      ]);

      setClients(setCached('vcon:clients', clientData.clients || []));
      setFiles(setCached('vcon:storage-files', storageData.files || []));
      if (storageData.stats) setCached('vcon:storage-stats', storageData.stats);
      if (metricsData) {
        setCached('vcon:metrics', metricsData);
        if (metricsData.bufferStats) {
          setBufferedCount(Number(metricsData.bufferStats.currentBufferSize) || 0);
        }
      }
      if (bufferedData?.bufferedSummary) {
        setBufferedSummary(setCached('vcon:buffered-summary', bufferedData.bufferedSummary));
      }
      setLoadError('');
    } catch (fetchError) {
      setLoadError(
        fetchError instanceof Error ? fetchError.message : 'Unable to load export data'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshExportData();
  }, [refreshExportData]);

  useEffect(() => {
    const updateClock = () => setNow(Date.now());
    updateClock();
    const interval = setInterval(updateClock, 30_000);
    return () => clearInterval(interval);
  }, []);

  const filteredFiles = useMemo(
    () =>
      files.filter(
        (file) =>
          matchesSelectedClientFolder(file.clientId, selectedClient) &&
          (!fromDate || file.date >= fromDate) &&
          (!toDate || file.date <= toDate)
      ),
    [files, fromDate, selectedClient, toDate]
  );

  const preview = useMemo(
    () => ({
      rows: filteredFiles.reduce((total, file) => total + file.linesCount, 0),
      bytes: filteredFiles.reduce((total, file) => total + file.sizeBytes, 0),
      files: filteredFiles.length,
    }),
    [filteredFiles]
  );

  const stats = useMemo(
    () => ({
      rows: files.reduce((total, file) => total + file.linesCount, 0),
      bytes: files.reduce((total, file) => total + file.sizeBytes, 0),
      clients: new Set(files.map((file) => file.clientId)).size,
    }),
    [files]
  );

  const sortedRecentFiles = useMemo(
    () =>
      [...files]
        .sort(
          (left, right) =>
            new Date(right.modifiedAt).getTime() - new Date(left.modifiedAt).getTime()
        )
        .slice(0, 6),
    [files]
  );

  const setQuickRange = (nextPreset: Exclude<RangePreset, 'custom'>) => {
    setPreset(nextPreset);
    const range = getUtcDateRangeForPreset(nextPreset);
    setFromDate(range.from);
    setToDate(range.to);
  };

  const exportUrl = useMemo(() => {
    const params = new URLSearchParams({ clientId: selectedClient, format });
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    return `/api/export?${params.toString()}`;
  }, [format, fromDate, selectedClient, toDate]);

  const filteredBuffered = useMemo(
    () =>
      countMatchingBufferedEvents(
        bufferedSummary,
        { clientId: selectedClient, fromDate, toDate },
        bufferedCount,
      ),
    [bufferedCount, bufferedSummary, fromDate, selectedClient, toDate],
  );

  const invalidRange = Boolean(fromDate && toDate && fromDate > toDate);
  const nothingToExport = preview.rows === 0 && !filteredBuffered.hasPotentialBuffered;

  const triggerBlobDownload = (blob: Blob, filename: string) => {
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
  };

  const downloadExport = async () => {
    if (invalidRange) {
      error('Invalid date range', 'Start date must be on or before end date.');
      return;
    }
    if (nothingToExport) {
      error('Nothing to export', 'No stored rows or buffered events match the selected filters.');
      return;
    }
    setDownloading(true);
    try {
      const res = await fetch(exportUrl, { cache: 'no-store' });
      if (res.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      if (!res.ok) {
        const errorJson = await res.json().catch(() => ({}));
        error(
          'Export failed',
          errorJson.error || `Export endpoint returned HTTP ${res.status}.`
        );
        return;
      }
      const blob = await res.blob();
      const defaultName = `datastack_export_${selectedClient || 'all'}_${new Date().toISOString().slice(0, 10)}.${format}`;
      const filename = extractContentDispositionFilename(
        res.headers.get('content-disposition'),
        defaultName
      );
      triggerBlobDownload(blob, filename);
      info(
        'Export downloaded',
        filteredBuffered.matchingCount > 0
          ? `${format.toUpperCase()} download (${preview.rows.toLocaleString()} stored + ${filteredBuffered.matchingCount.toLocaleString()} buffered flushed).`
          : filteredBuffered.unattributedCount > 0
            ? `${format.toUpperCase()} download (${preview.rows.toLocaleString()} stored + pending backlog flushed).`
            : `${format.toUpperCase()} download for ${preview.rows.toLocaleString()} rows.`
      );
      await refreshExportData();
    } catch (err: unknown) {
      error('Export failed', err instanceof Error ? err.message : 'Unable to export dataset.');
    } finally {
      setDownloading(false);
    }
  };

  const downloadFile = async (file: StorageFile) => {
    const url = `/api/export?clientId=${encodeURIComponent(file.clientId)}&filename=${encodeURIComponent(file.filename)}`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      if (!res.ok) {
        const errorJson = await res.json().catch(() => ({}));
        error('Download Failed', errorJson.error || 'Requested CSV file could not be exported.');
        return;
      }
      const blob = await res.blob();
      triggerBlobDownload(blob, file.filename);
      await refreshExportData();
    } catch (err: unknown) {
      error('Download Failed', err instanceof Error ? err.message : 'Export download error');
    }
  };

  const rangeChanged = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPreset('custom');
  };

  const resetExport = () => {
    setSelectedClient('all');
    setFormat('csv');
    setQuickRange('all');
  };

  return (
    <PageShell title="Export">
      <StatStrip
        items={[
          { label: 'Files', value: files.length.toLocaleString() },
          { label: 'Rows', value: stats.rows.toLocaleString() },
          { label: 'Storage', value: formatBytes(stats.bytes) },
          { label: 'Clients', value: stats.clients.toLocaleString() },
        ]}
      />

      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-5">
        <Panel
          title="Export builder"
          bodyClassName="flex flex-col gap-3 p-3"
          className="min-w-0 lg:col-span-3"
        >
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
              Range
            </span>
            {(
              [
                ['today', 'Today'],
                ['7d', '7d'],
                ['30d', '30d'],
                ['all', 'All'],
              ] as const
            ).map(([id, label]) => (
              <Pill key={id} active={preset === id} onClick={() => setQuickRange(id)}>
                {label}
              </Pill>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-px border border-[var(--border)] bg-[var(--border)] md:grid-cols-[1.2fr_1fr_1fr]">
            <div className="min-w-0 bg-[var(--surface)] p-2.5">
              <Select
                label="Client"
                compact
                value={selectedClient}
                onChange={(event) => setSelectedClient(event.target.value)}
              >
                <option value="all">All clients</option>
                {clients.map((client) => (
                  <option key={client.clientId} value={client.clientId}>
                    {client.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="min-w-0 bg-[var(--surface)] p-2.5">
              <Input
                label="From"
                compact
                type="date"
                value={fromDate}
                onChange={(event) => rangeChanged(setFromDate, event.target.value)}
              />
            </div>
            <div className="min-w-0 bg-[var(--surface)] p-2.5">
              <Input
                label="To"
                compact
                type="date"
                value={toDate}
                onChange={(event) => rangeChanged(setToDate, event.target.value)}
              />
            </div>
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
              Format
            </legend>
            <div
              className="grid grid-cols-3 gap-2"
              role="radiogroup"
              aria-label="Export format"
            >
              <FormatOption
                value="csv"
                selected={format === 'csv'}
                label="CSV"
                onSelect={setFormat}
              />
              <FormatOption
                value="json"
                selected={format === 'json'}
                label="JSON"
                onSelect={setFormat}
              />
              <FormatOption
                value="ndjson"
                selected={format === 'ndjson'}
                label="NDJSON"
                onSelect={setFormat}
              />
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
              <span>
                <strong className="font-medium text-[var(--text)]">
                  {preview.rows.toLocaleString()}
                </strong>{' '}
                rows
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <strong className="font-medium text-[var(--text)]">
                  ~{formatBytes(preview.bytes)}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <strong className="font-medium text-[var(--text)]">
                  {preview.files}
                </strong>{' '}
                files
              </span>
              {filteredBuffered.matchingCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-[var(--warning)]">
                    +{filteredBuffered.matchingCount.toLocaleString()} buffered (flushed on export)
                  </span>
                </>
              )}
              {filteredBuffered.matchingCount === 0 && filteredBuffered.unattributedCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-[var(--warning)]">
                    +{filteredBuffered.unattributedCount.toLocaleString()} queued backlog (flushed on export)
                  </span>
                </>
              )}
            </div>
            {loadError && (
              <p role="alert" className="text-[11px] text-[var(--danger)]">
                {loadError}
              </p>
            )}
            {invalidRange && (
              <p role="alert" className="text-[11px] text-[var(--danger)]">
                Start date must be on or before end date.
              </p>
            )}
            {!loading && !invalidRange && nothingToExport && (
              <p role="status" className="text-[11px] text-[var(--text-faint)]">
                No stored rows or buffered events match the selected filters.
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-[var(--border)] pt-2.5">
            <Button type="button" size="xs" onClick={resetExport}>
              Reset
            </Button>
            <Button
              type="button"
              variant="primary"
              size="xs"
              icon="Download"
              loading={downloading}
              disabled={loading || downloading || invalidRange || nothingToExport}
              onClick={() => void downloadExport()}
            >
              Download {format.toUpperCase()}
            </Button>
          </div>
        </Panel>

        <Panel
          title="Files"
          action={
            <Link
              href="/vcon/storage"
              className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              View all
            </Link>
          }
          bodyClassName="divide-y divide-[var(--border)]"
          className="min-w-0 lg:col-span-2"
        >
          {loading ? (
            <p className="px-3 py-4 text-[11.5px] text-[var(--text-faint)]">
              Loading...
            </p>
          ) : sortedRecentFiles.length === 0 ? (
            <p className="px-3 py-4 text-[11.5px] text-[var(--text-faint)]">
              No files
            </p>
          ) : (
            sortedRecentFiles.map((file) => (
              <div
                key={`${file.clientId}/${file.filename}`}
                className="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-[var(--surface-2)]"
              >
                <span className="shrink-0 border border-[var(--border-strong)] px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--text-muted)]">
                  CSV
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[11.5px] text-[var(--text)]">
                    {file.filename}
                  </div>
                  <div className="truncate text-[10px] tabular-nums text-[var(--text-faint)]">
                    {file.clientId} · {relativeTime(file.modifiedAt, now)} ·{' '}
                    {file.linesCount.toLocaleString()} rows ·{' '}
                    {formatBytes(file.sizeBytes)}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="icon"
                  size="icon"
                  icon="Download"
                  className="h-6 w-6 shrink-0"
                  aria-label={`Download ${file.filename}`}
                  title={`Download ${file.filename}`}
                  onClick={() => downloadFile(file)}
                />
              </div>
            ))
          )}
        </Panel>
      </div>
    </PageShell>
  );
}

function FormatOption({
  value,
  selected,
  label,
  onSelect,
}: {
  value: ExportFormat;
  selected: boolean;
  label: string;
  onSelect: (value: ExportFormat) => void;
}) {
  const FormatIcon = value === 'csv' ? FileText : Braces;

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`flex min-w-0 items-center gap-2 border px-2.5 py-1.5 text-left transition-colors ${
        selected
          ? 'border-[var(--border-strong)] bg-[var(--surface-2)]'
          : 'border-[var(--border)] hover:border-[var(--border-strong)]'
      }`}
      onClick={() => onSelect(value)}
    >
      <span
        className={`grid h-6 w-6 shrink-0 place-items-center border ${
          selected
            ? 'border-[var(--border-strong)] text-[var(--accent)]'
            : 'border-[var(--border)] text-[var(--text-muted)]'
        }`}
      >
        <FormatIcon className="h-3 w-3" aria-hidden="true" />
      </span>
      <span className="text-[11.5px] font-medium text-[var(--text)]">{label}</span>
    </button>
  );
}
