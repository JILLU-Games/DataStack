'use client';

import { PageShell } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
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
import Link from 'next/link';
import React, { useCallback, useEffect, useState } from 'react';

interface AuditLogItem {
  id: string;
  actorEmail: string;
  actorRole: string;
  action: string;
  target: string;
  ipAddress: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

const ACTION_FILTER_OPTIONS = [
  { value: 'ALL', label: 'All Governance Actions' },
  { value: 'ADMIN_LOGIN', label: 'ADMIN_LOGIN' },
  { value: 'ADMIN_PASSWORD_UPDATED', label: 'ADMIN_PASSWORD_UPDATED' },
  { value: 'TEAM_MEMBER_CREATED', label: 'TEAM_MEMBER_CREATED' },
  { value: 'TEAM_MEMBER_UPDATED', label: 'TEAM_MEMBER_UPDATED' },
  { value: 'TEAM_MEMBER_REVOKED', label: 'TEAM_MEMBER_REVOKED' },
  { value: 'TEAM_MEMBER_DELETED', label: 'TEAM_MEMBER_DELETED' },
  { value: 'CLIENT_CREATED', label: 'CLIENT_CREATED' },
  { value: 'CLIENT_UPDATED', label: 'CLIENT_UPDATED' },
  { value: 'CLIENT_TOKEN_ROTATED', label: 'CLIENT_TOKEN_ROTATED' },
  { value: 'CLIENT_DELETED', label: 'CLIENT_DELETED' },
  { value: 'SETTINGS_UPDATED', label: 'SETTINGS_UPDATED' },
  { value: 'S3_ARCHIVE_TRIGGERED', label: 'S3_ARCHIVE_TRIGGERED' },
  { value: 'WEBHOOK_TEST_TRIGGERED', label: 'WEBHOOK_TEST_TRIGGERED' },
];

export function AuditLogViewer() {
  const { error } = useToast();
  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [actionFilter, setActionFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const fetchAuditLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', '150');
      if (actionFilter && actionFilter !== 'ALL') {
        params.set('action', actionFilter);
      }
      if (searchQuery.trim()) {
        params.set('q', searchQuery.trim());
      }
      const res = await fetch(`/api/audit?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (res.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to load audit logs.');
      }
      setLogs(Array.isArray(data.logs) ? data.logs : []);
    } catch (err: unknown) {
      error(err instanceof Error ? err.message : 'Unable to load audit logs.');
    } finally {
      setLoading(false);
    }
  }, [actionFilter, searchQuery, error]);

  useEffect(() => {
    void fetchAuditLogs();
  }, [fetchAuditLogs]);

  const uniqueActors = new Set(logs.map((l) => l.actorEmail)).size;
  const mutationCount = logs.filter((l) => l.action !== 'ADMIN_LOGIN').length;

  return (
    <PageShell
      title="Admin Audit Log"
      actions={
        <div className="flex items-center gap-1.5">
          <Link href="/vcon/team">
            <Button variant="secondary" size="sm" icon="Users">
              Team & RBAC
            </Button>
          </Link>
          <Button
            variant="secondary"
            size="sm"
            icon="RefreshCw"
            onClick={() => void fetchAuditLogs()}
            loading={loading}
          >
            Refresh
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <StatStrip
          items={[
            {
              label: 'Recorded Events',
              value: String(logs.length),
              dot: 'ok',
            },
            {
              label: 'Distinct Actors',
              value: String(uniqueActors),
            },
            {
              label: 'Config & Client Mutations',
              value: String(mutationCount),
            },
            {
              label: 'Telemetry Separation',
              value: 'Strict (0 CSV Rows)',
              dot: 'ok',
            },
          ]}
        />

        <Panel
          title="Governance Event Trail"
          meta={`${logs.length} ENTRIES`}
        >
          <div className="p-3 pb-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Select
              label="Filter by Action"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              options={ACTION_FILTER_OPTIONS}
            />
            <div className="sm:col-span-2">
              <Input
                label="Search Actor, Target, or IP"
                placeholder="Search email, client_id, action, or IP..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>

          <TableWrap>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp (UTC)</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target Resource</TableHead>
                  <TableHead>Source IP</TableHead>
                  <TableHead>Metadata</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.length === 0 ? (
                  <TableEmpty
                    colSpan={6}
                    message={
                      loading
                        ? 'Loading audit trail...'
                        : 'No audit log entries match the current filters.'
                    }
                  />
                ) : (
                  logs.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <span className="font-mono text-[11px] text-[var(--text-muted)]">
                          {row.createdAt
                            ? row.createdAt.replace('T', ' ').slice(0, 19)
                            : '—'}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[11.5px] text-[var(--text)]">
                            {row.actorEmail}
                          </span>
                          <span className="border border-[var(--border)] bg-[var(--surface-2)] px-1 py-0.2 text-[9.5px] uppercase text-[var(--text-muted)]">
                            {row.actorRole}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="border border-[var(--border-strong)] bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-[var(--accent)]">
                          {row.action}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-[11px] text-[var(--text)]">
                          {row.target}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-[11px] text-[var(--text-muted)]">
                          {row.ipAddress || 'unknown'}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="block max-w-[260px] truncate font-mono text-[10.5px] text-[var(--text-faint)]">
                          {JSON.stringify(row.metadata || {})}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableWrap>
        </Panel>
      </div>
    </PageShell>
  );
}

export default AuditLogViewer;
