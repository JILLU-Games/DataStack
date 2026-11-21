'use client';

import { PageShell } from '@/components/layout/PageShell';
import { useVconRole } from '@/components/layout/VconShell';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
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

interface TeamMemberItem {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'operator' | 'viewer';
  status: 'active' | 'disabled';
  tokenVersion: number;
  invitedBy: string;
  isPrimaryOwner: boolean;
  createdAt: string;
  updatedAt: string;
}

export function TeamWorkspace() {
  const { success, error } = useToast();
  const shellRole = useVconRole();
  const [members, setMembers] = useState<TeamMemberItem[]>([]);
  const [currentRole, setCurrentRole] = useState<string>(() => shellRole || 'viewer');
  const [loading, setLoading] = useState<boolean>(true);

  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [newEmail, setNewEmail] = useState<string>('');
  const [newPassword, setNewPassword] = useState<string>('');
  const [newRole, setNewRole] = useState<string>('viewer');
  const [creating, setCreating] = useState<boolean>(false);
  const [deleteTarget, setDeleteTarget] = useState<TeamMemberItem | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchMembers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/team', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (res.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to load team members.');
      }
      setMembers(Array.isArray(data.members) ? data.members : []);
      if (data.currentRole) {
        setCurrentRole(data.currentRole);
      }
    } catch (err: unknown) {
      error(err instanceof Error ? err.message : 'Unable to load team members.');
    } finally {
      setLoading(false);
    }
  }, [error]);

  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers]);

  const isOwner = currentRole === 'owner';

  const handleCreateMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.trim() || !newPassword) {
      error('Email and password are required.');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/team', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newEmail.trim(),
          password: newPassword,
          role: newRole,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to create team member.');
      }
      success(`Added ${data.member?.email || newEmail} (${newRole}).`);
      setNewEmail('');
      setNewPassword('');
      setNewRole('viewer');
      setCreateOpen(false);
      await fetchMembers();
    } catch (err: unknown) {
      error(err instanceof Error ? err.message : 'Unable to create team member.');
    } finally {
      setCreating(false);
    }
  };

  const handleRoleChange = async (member: TeamMemberItem, nextRole: string) => {
    if (member.isPrimaryOwner) {
      error('Primary Owner role cannot be modified.');
      return;
    }
    setBusyId(member.id);
    try {
      const res = await fetch(`/api/team/${encodeURIComponent(member.id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Role update failed.');
      }
      success(`Updated ${member.email} role to ${nextRole}.`);
      await fetchMembers();
    } catch (err: unknown) {
      error(err instanceof Error ? err.message : 'Unable to update role.');
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleStatus = async (member: TeamMemberItem) => {
    if (member.isPrimaryOwner) {
      error('Primary Owner cannot be disabled.');
      return;
    }
    const nextStatus = member.status === 'active' ? 'disabled' : 'active';
    setBusyId(member.id);
    try {
      const res = await fetch(`/api/team/${encodeURIComponent(member.id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus, revokeSessions: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Status update failed.');
      }
      success(
        nextStatus === 'disabled'
          ? `Revoked access and active sessions for ${member.email}.`
          : `Re-enabled access for ${member.email}.`
      );
      await fetchMembers();
    } catch (err: unknown) {
      error(err instanceof Error ? err.message : 'Unable to update member status.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteMember = async (member: TeamMemberItem) => {
    if (member.isPrimaryOwner) {
      error('Primary Owner cannot be deleted.');
      return;
    }
    setBusyId(member.id);
    try {
      const res = await fetch(`/api/team/${encodeURIComponent(member.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Delete failed.');
      }
      success(`Removed ${member.email} from team.`);
      setDeleteTarget(null);
      await fetchMembers();
    } catch (err: unknown) {
      error(err instanceof Error ? err.message : 'Unable to delete team member.');
    } finally {
      setBusyId(null);
    }
  };

  const activeCount = members.filter((m) => m.status === 'active').length;
  const ownerCount = members.filter((m) => m.role === 'owner').length;
  const operatorCount = members.filter(
    (m) => m.role === 'admin' || m.role === 'operator'
  ).length;
  const viewerCount = members.filter((m) => m.role === 'viewer').length;

  return (
    <PageShell
      title="Team & RBAC"
      actions={
        <div className="flex items-center gap-1.5">
          <Link href="/vcon/audit">
            <Button variant="secondary" size="sm" icon="FileText">
              Audit Log
            </Button>
          </Link>
          <Button
            variant="secondary"
            size="sm"
            icon="RefreshCw"
            onClick={() => void fetchMembers()}
            loading={loading}
          >
            Refresh
          </Button>
          {isOwner && (
            <Button
              variant="primary"
              size="sm"
              icon="UserPlus"
              onClick={() => setCreateOpen(true)}
            >
              Add Team Member
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <StatStrip
          items={[
            {
              label: 'Total Members',
              value: `${members.length} (${activeCount} active)`,
              dot: 'ok',
            },
            {
              label: 'Owners',
              value: String(ownerCount),
            },
            {
              label: 'Operators / Admins',
              value: String(operatorCount),
            },
            {
              label: 'Viewers',
              value: String(viewerCount),
            },
          ]}
        />

        <Panel
          title="Administrator Directory"
          meta={`ROLE: ${currentRole.toUpperCase()}`}
        >
          <TableWrap>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Token Version</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.length === 0 ? (
                  <TableEmpty
                    colSpan={6}
                    message={
                      loading
                        ? 'Loading team members...'
                        : 'No team members registered.'
                    }
                  />
                ) : (
                  members.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11.5px] font-medium text-[var(--text)]">
                            {row.email}
                          </span>
                          {row.isPrimaryOwner && (
                            <span className="border border-[var(--accent)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider text-[var(--accent)]">
                              Primary Owner
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {row.isPrimaryOwner || !isOwner ? (
                          <span className="border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[10.5px] uppercase text-[var(--text)]">
                            {row.role}
                          </span>
                        ) : (
                          <Select
                            compact
                            aria-label={`Role for ${row.email}`}
                            value={row.role}
                            disabled={busyId === row.id}
                            onChange={(e) =>
                              void handleRoleChange(row, e.target.value)
                            }
                            options={[
                              { value: 'viewer', label: 'Viewer (Read-Only)' },
                              { value: 'operator', label: 'Operator (Manage Clients)' },
                              { value: 'admin', label: 'Admin (Manage Clients)' },
                              { value: 'owner', label: 'Owner (Full Control)' },
                            ]}
                          />
                        )}
                      </TableCell>
                      <TableCell>
                        <span
                          className={
                            row.status === 'active'
                              ? 'border border-[var(--success)]/40 bg-[var(--success)]/10 px-1.5 py-0.5 text-[10px] uppercase text-[var(--success)]'
                              : 'border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-1.5 py-0.5 text-[10px] uppercase text-[var(--danger)]'
                          }
                        >
                          {row.status}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-[11px] text-[var(--text-muted)]">
                          v{row.tokenVersion}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-[11px] text-[var(--text-muted)]">
                          {row.createdAt ? row.createdAt.slice(0, 10) : '—'}
                        </span>
                      </TableCell>
                      <TableCell>
                        {row.isPrimaryOwner ? (
                          <span className="text-[11px] text-[var(--text-faint)]">
                            Immutable (id=1)
                          </span>
                        ) : isOwner ? (
                          <div className="flex items-center gap-1.5">
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busyId === row.id}
                              onClick={() => void handleToggleStatus(row)}
                            >
                              {row.status === 'active' ? 'Revoke' : 'Activate'}
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={busyId === row.id}
                              onClick={() => setDeleteTarget(row)}
                            >
                              Remove
                            </Button>
                          </div>
                        ) : (
                          <span className="text-[11px] text-[var(--text-faint)]">
                            Owner required
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableWrap>
        </Panel>
      </div>

      <Modal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Add Administrator / Team Member"
      >
        <form onSubmit={handleCreateMember} className="flex flex-col gap-3">
          <Input
            label="Email Address"
            type="email"
            placeholder="operator@datastack.dev"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            required
          />
          <Input
            label="Initial Password (min 8 chars)"
            type="password"
            placeholder="StrongPassword123!"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
          <Select
            label="Assigned RBAC Role"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            options={[
              {
                value: 'viewer',
                label: 'Viewer — Read-only dashboards, events, clients & exports',
              },
              {
                value: 'operator',
                label: 'Operator — Manage SDK clients, tokens & manual flushes',
              },
              {
                value: 'admin',
                label: 'Admin — Operational role (manage SDK clients & flushes)',
              },
              {
                value: 'owner',
                label: 'Owner — Full platform settings, secrets & team control',
              },
            ]}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={creating}
            >
              Create Member
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={Boolean(deleteTarget)}
        onClose={() => {
          if (!busyId) setDeleteTarget(null);
        }}
        title="Confirm Team Member Removal"
        maxWidth="sm"
      >
        {deleteTarget && (
          <div className="flex flex-col gap-3">
            <p className="text-[12px] text-[var(--text-muted)] leading-relaxed">
              Remove{' '}
              <span className="font-mono font-medium text-[var(--text)]">
                {deleteTarget.email}
              </span>{' '}
              (<span className="font-mono uppercase">{deleteTarget.role}</span>) from
              administrator access? Active sessions will stop working immediately.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busyId === deleteTarget.id}
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                data-testid="confirm-remove-member"
                loading={busyId === deleteTarget.id}
                disabled={busyId === deleteTarget.id}
                onClick={() => void handleDeleteMember(deleteTarget)}
              >
                Confirm Remove
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </PageShell>
  );
}

export default TeamWorkspace;
