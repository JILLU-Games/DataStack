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
  const { success, error } = useToast();
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
      if (res.ok) {
        const data = await res.json();
        success('Buffer Flushed', `Flushed ${data.flushedCount} events to CSV`);
        fetchStorageData();
      } else {
        error('Flush Failed', 'Could not flush buffer');
      }
    } catch (err: any) {
      error('Error', err.message);
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
          { label: 'Rotation', value: '100MB / Daily' },
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
