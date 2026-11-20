'use client';

import { PageShell } from '@/components/layout/PageShell';
import { useVconRole } from '@/components/layout/VconShell';
import { Button } from '@/components/ui/Button';
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
import { getVconRoleCapabilities } from '@/lib/vconUiHelpers';
import { useCallback, useEffect, useState } from 'react';

interface StorageStatsSummary {
  totalMB?: string;
  totalFiles?: number;
  totalRows?: number;
  rotationRule?: string;
  rotationMb?: number;
}

interface StoragePartitionFile {
  clientId: string;
  filename: string;
  sizeBytes: number;
  linesCount: number;
  modifiedAt: string;
  compressed?: boolean;
}

export default function StoragePage() {
  const { success, warning, error } = useToast();
  const currentRole = useVconRole();
  const { canOperate } = getVconRoleCapabilities(currentRole);
  const [stats, setStats] = useState<StorageStatsSummary | null>(() =>
    getCached<StorageStatsSummary | null>('vcon:storage-stats', null)
  );
  const [files, setFiles] = useState<StoragePartitionFile[]>(() =>
    getCached<StoragePartitionFile[]>('vcon:storage-files', [])
  );
  const [refreshing, setRefreshing] = useState(false);
  const [flushing, setFlushing] = useState(false);

  const fetchStorageData = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/storage', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Unable to load storage partitions');
      }
      setStats(setCached('vcon:storage-stats', data.stats ?? null));
      setFiles(setCached('vcon:storage-files', data.files || []));
    } catch (loadErr) {
      error(
        'Storage load failed',
        loadErr instanceof Error
          ? loadErr.message
          : 'Could not load storage partitions.'
      );
    } finally {
      setRefreshing(false);
    }
  }, [error]);

  useEffect(() => {
    void fetchStorageData();
  }, [fetchStorageData]);

  const handleManualFlush = async () => {
    if (!canOperate) {
      error('Read-only role', 'Buffer flush requires operator or owner permissions.');
      return;
    }
    setFlushing(true);
    try {
      const res = await fetch('/api/storage', {
        method: 'POST',
        cache: 'no-store',
      });
      if (res.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        const count = Number(data.flushedCount) || 0;
        if (data.warning) {
          warning(
            'Partial Flush (Web Only)',
            `Flushed ${count} event${count === 1 ? '' : 's'}. ${String(data.warning)}`
          );
        } else {
          success(
            'Buffer Flushed',
            `Flushed ${count} event${count === 1 ? '' : 's'} to CSV.`
          );
        }
        await fetchStorageData();
      } else if (data.flushedCount !== undefined && Number(data.flushedCount) > 0) {
        warning(
          'Partial Flush',
          `Flushed ${data.flushedCount} local events. Ingestion server: ${data.error || 'flush failed'}`
        );
        await fetchStorageData();
      } else {
        error('Flush Failed', data.error || 'Could not flush buffer');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown network error';
      error('Flush Error', msg);
    } finally {
      setFlushing(false);
    }
  };

  return (
    <PageShell
      title="Storage"
      actions={
        <>
          <Button
            size="xs"
            variant="secondary"
            icon="RotateCw"
            loading={refreshing}
            disabled={refreshing || flushing}
            onClick={() => void fetchStorageData()}
          >
            Refresh
          </Button>
          {canOperate ? (
            <Button
              size="xs"
              variant="primary"
              icon="HardDrive"
              loading={flushing}
              disabled={flushing}
              onClick={() => void handleManualFlush()}
            >
              Flush Buffer
            </Button>
          ) : (
            <span className="border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 font-mono text-[10.5px] uppercase tracking-wider text-[var(--text-muted)]">
              Read-only ({currentRole})
            </span>
          )}
        </>
      }
    >
      <StatStrip
        items={[
          { label: 'Disk usage', value: `${stats?.totalMB ?? '0.00'} MB` },
          { label: 'CSV files', value: stats?.totalFiles ?? 0 },
          {
            label: 'Persisted rows',
            value: stats?.totalRows ? stats.totalRows.toLocaleString() : 0,
          },
          {
            label: 'Rotation',
            value: stats?.rotationRule || `${stats?.rotationMb ?? 100}MB / Daily`,
          },
        ]}
      />

      <Panel title="CSV partitions" meta={`${files.length}`}>
        <TableWrap className="border-0 bg-transparent">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Filename</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Rows</TableHead>
                <TableHead>Modified</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.length === 0 ? (
                <TableEmpty colSpan={5} message="No CSV files" />
              ) : (
                files.map((file) => {
                  const isCompressed = Boolean(
                    file.compressed ||
                      file.filename.toLowerCase().endsWith('.csv.gz')
                  );
                  return (
                    <TableRow key={`${file.clientId}/${file.filename}`}>
                      <TableCell className="font-mono text-[var(--accent)]">
                        {file.clientId}
                      </TableCell>
                      <TableCell className="font-mono font-medium text-[var(--text)]">
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 border border-[var(--border-strong)] px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--text-muted)]">
                            {isCompressed ? 'CSV.GZ' : 'CSV'}
                          </span>
                          <span>{file.filename}</span>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono tabular-nums">
                        {(file.sizeBytes / 1024).toFixed(1)} KB
                      </TableCell>
                      <TableCell className="font-mono tabular-nums">
                        {file.linesCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="font-mono tabular-nums text-[var(--text-dim)]">
                        {new Date(file.modifiedAt).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </TableWrap>
      </Panel>
    </PageShell>
  );
}
