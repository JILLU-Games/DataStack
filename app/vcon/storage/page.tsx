'use client';

import { PageShell } from '@/components/layout/PageShell';
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
import { useCallback, useEffect, useState } from 'react';

export default function StoragePage() {
  const { success, warning, error } = useToast();
  const [stats, setStats] = useState<any>(() =>
    getCached<any>('vcon:storage-stats', null)
  );
  const [files, setFiles] = useState<any[]>(() =>
    getCached<any[]>('vcon:storage-files', [])
  );
  const [flushing, setFlushing] = useState(false);

  const fetchStorageData = useCallback(async () => {
    try {
      const res = await fetch('/api/storage');
      if (!res.ok) throw new Error('Unable to load storage partitions');
      const data = await res.json();
      setStats(setCached('vcon:storage-stats', data.stats));
      setFiles(setCached('vcon:storage-files', data.files || []));
    } catch {
      error('Storage load failed', 'Could not load storage partitions.');
    }
  }, [error]);

  useEffect(() => {
    fetchStorageData();
  }, [fetchStorageData]);

  const handleManualFlush = async () => {
    setFlushing(true);
    try {
      const res = await fetch('/api/storage', { method: 'POST' });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        const count = Number(data.flushedCount) || 0;
        success(
          'Buffer Flushed',
          `Flushed ${count} event${count === 1 ? '' : 's'} to CSV${data.warning ? ` (${data.warning})` : ''}`
        );
        fetchStorageData();
      } else if (data.flushedCount !== undefined && data.flushedCount > 0) {
        // Partial flush: local events persisted, remote Port 4000 flush returned error
        warning(
          'Partial Flush',
          `Flushed ${data.flushedCount} local events. Ingestion server: ${data.error || 'flush failed'}`
        );
        fetchStorageData();
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
            onClick={fetchStorageData}
          >
            Refresh
          </Button>
          <Button
            size="xs"
            variant="primary"
            icon="HardDrive"
            loading={flushing}
            onClick={handleManualFlush}
          >
            Flush Buffer
          </Button>
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
                files.map((file, idx) => (
                  <TableRow key={idx}>
                    <TableCell className="font-mono text-[var(--accent)]">
                      {file.clientId}
                    </TableCell>
                    <TableCell className="font-mono font-medium text-[var(--text)]">
                      {file.filename}
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
                ))
              )}
            </TableBody>
          </Table>
        </TableWrap>
      </Panel>
    </PageShell>
  );
}
