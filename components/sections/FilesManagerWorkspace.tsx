'use client';

import { PageShell } from '@/components/layout/PageShell';
import { useVconRole } from '@/components/layout/VconShell';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { getVconRoleCapabilities } from '@/lib/vconUiHelpers';
import React, { useCallback, useEffect, useState } from 'react';

type EngineStatus = 'checking' | 'online' | 'offline';

interface FilesEngineStatusResponse {
  ok?: boolean;
  engine?: string;
  role?: string;
  readOnly?: boolean;
  proxyMode?: 'nginx' | 'standalone';
  wsSupported?: boolean;
  wsHint?: string | null;
  error?: string;
  code?: string;
}

const FILES_ENGINE_STATUS_URL = '/api/files/status';
const FILES_ENGINE_FRAME_URL = '/vcon/files-engine';

export function FilesManagerWorkspace() {
  const currentRole = useVconRole();
  const { canOperate } = getVconRoleCapabilities(currentRole);

  const [status, setStatus] = useState<EngineStatus>('checking');
  const [statusError, setStatusError] = useState<string>('');
  const [wsHint, setWsHint] = useState<string | null>(null);
  const [engineReadOnly, setEngineReadOnly] = useState<boolean>(!canOperate);
  const [frameKey, setFrameKey] = useState<number>(1);
  const [probing, setProbing] = useState<boolean>(false);

  const checkEngineStatus = useCallback(async (reloadFrame = false) => {
    setProbing(true);
    setStatusError('');
    try {
      const response = await fetch(FILES_ENGINE_STATUS_URL, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
      });

      if (response.status === 401) {
        window.location.assign('/vcon/login?next=%2Fvcon%2Ffiles');
        return;
      }

      const data = (await response.json().catch(() => ({}))) as FilesEngineStatusResponse;
      setWsHint(typeof data.wsHint === 'string' && data.wsHint ? data.wsHint : null);

      if (response.ok && data.ok) {
        setEngineReadOnly(Boolean(data.readOnly));
        setStatus('online');
        if (reloadFrame) {
          setFrameKey((prev) => prev + 1);
        }
        return;
      }

      setStatus('offline');
      setStatusError(
        data.error ||
          `Files Manager engine returned HTTP ${response.status}. Ensure the Port 4000 ingestion server is running.`
      );
    } catch {
      setStatus('offline');
      setStatusError(
        'Cannot reach the Port 4000 Files Manager engine. Start both services with "npm run dev:all" or Docker Compose.'
      );
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void checkEngineStatus(false);
  }, [checkEngineStatus]);

  const effectiveReadOnly = !canOperate || engineReadOnly;

  return (
    <PageShell
      title="Files Manager"
      actions={
        <>
          <span
            className="border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 font-mono text-[10.5px] uppercase tracking-wider text-[var(--text-muted)]"
            data-testid="files-manager-access-badge"
          >
            {effectiveReadOnly
              ? `Read-only (${currentRole})`
              : `Full Access (${currentRole})`}
          </span>
          <Button
            size="xs"
            variant="secondary"
            icon="RotateCw"
            loading={probing}
            disabled={probing}
            onClick={() => void checkEngineStatus(true)}
          >
            Reload
          </Button>
          {status === 'online' && (
            <a
              href={FILES_ENGINE_FRAME_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-6 items-center gap-1.5 border border-[var(--border)] bg-[var(--surface)] px-2 text-[11px] font-medium text-[var(--text)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]"
            >
              <Icon name="ExternalLink" size={12} />
              <span>Full View</span>
            </a>
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[11.5px] text-[var(--text-muted)]">
        <div className="flex items-center gap-2">
          <Icon name="FolderOpen" size={13} className="shrink-0 text-[var(--accent)]" />
          <span>
            Root: <code className="font-mono text-[var(--text)]">/storage/data</code> — browse, edit, rename, upload, download, and ZIP/UNZIP client partitions.
          </span>
        </div>
        <span className="font-mono text-[10.5px] text-[var(--text-dim)]">
          {effectiveReadOnly
            ? 'Viewer mode: browse, view & download only'
            : 'Active *.lock files are protected; avoid editing live UTC-today CSVs during peak flush'}
        </span>
      </div>

      {status === 'online' && wsHint && (
        <div
          className="flex items-center gap-2 border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[11px] text-[var(--text-muted)]"
          data-testid="files-manager-proxy-hint"
        >
          <Icon name="Info" size={12} className="shrink-0 text-[var(--accent)]" />
          <span>{wsHint}</span>
        </div>
      )}

      <div
        className="w-full overflow-hidden border border-[var(--border)] bg-[var(--surface)]"
        data-testid="files-manager-container"
      >
        {status === 'checking' && (
          <div className="flex h-[calc(100dvh-180px)] min-h-[480px] flex-col items-center justify-center gap-2.5 p-6 text-center">
            <Icon name="RotateCw" size={18} className="animate-spin text-[var(--accent)]" />
            <p className="text-[12.5px] font-medium text-[var(--text)]">
              Connecting to Files Manager engine...
            </p>
            <p className="text-[11.5px] text-[var(--text-dim)]">
              Verifying admin session and storage root on Port 4000
            </p>
          </div>
        )}

        {status === 'offline' && (
          <div
            className="flex h-[calc(100dvh-180px)] min-h-[480px] flex-col items-center justify-center gap-3 p-6 text-center"
            data-testid="files-manager-offline"
          >
            <div className="flex h-9 w-9 items-center justify-center border border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-muted)]">
              <Icon name="HardDrive" size={18} />
            </div>
            <div className="max-w-md space-y-1">
              <h2 className="text-[13px] font-medium text-[var(--text)]">
                Files Manager Engine Unavailable
              </h2>
              <p className="text-[12px] text-[var(--text-muted)]">
                {statusError ||
                  'The Port 4000 ingestion and files engine is currently offline.'}
              </p>
            </div>
            <div className="border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 font-mono text-[11px] text-[var(--text-dim)]">
              Local: npm run dev:all &nbsp;|&nbsp; Production: docker compose up
            </div>
            <Button
              size="sm"
              variant="primary"
              icon="RotateCw"
              loading={probing}
              disabled={probing}
              onClick={() => void checkEngineStatus(true)}
            >
              Retry Connection
            </Button>
          </div>
        )}

        {status === 'online' && (
          <iframe
            key={frameKey}
            src={FILES_ENGINE_FRAME_URL}
            title="DataStack Files Manager"
            data-testid="files-manager-iframe"
            className="block h-[calc(100dvh-180px)] min-h-[540px] w-full border-0 bg-[var(--surface)]"
          />
        )}
      </div>
    </PageShell>
  );
}

export default FilesManagerWorkspace;
