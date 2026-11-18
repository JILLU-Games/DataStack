'use client';

import { PageShell } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/Button';
import { FormSwitch } from '@/components/ui/Form';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import {
  SettingsField,
  SettingsFooter,
  SettingsGroup,
  SettingsPanel,
  SettingsTabs,
} from '@/components/ui/SettingsLayout';
import { StatStrip } from '@/components/ui/StatStrip';
import { useToast } from '@/components/ui/Toast';
import { getCached, setCached } from '@/lib/vconCache';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface EditableSettings {
  maxEventsPerSec: number;
  maxPayloadSizeKb: number;
  batchFlushThreshold: number;
  batchFlushIntervalMs: number;
  fileRotationMb: number;
  enableIdempotency: boolean;
  autoPruneDays: number;
}

interface PublicSettings extends EditableSettings {
  serverPort: number;
  webPort: number;
  updatedAt: string;
}

const DEFAULT_SETTINGS: EditableSettings = {
  maxEventsPerSec: 100,
  maxPayloadSizeKb: 100,
  batchFlushThreshold: 500,
  batchFlushIntervalMs: 2000,
  fileRotationMb: 100,
  enableIdempotency: true,
  autoPruneDays: 30,
};

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'connections', label: 'Connections' },
  { id: 'storage', label: 'Storage' },
  { id: 'security', label: 'Security' },
];

type TabId = (typeof TABS)[number]['id'];
type SocketHealthState = 'idle' | 'checking' | 'online' | 'offline';

export function SettingsWorkspace() {
  const { success, error } = useToast();
  const [settings, setSettings] = useState<EditableSettings>(() =>
    getCached<EditableSettings>('vcon:settings', DEFAULT_SETTINGS)
  );
  const [savedSettings, setSavedSettings] = useState<EditableSettings>(() =>
    getCached<EditableSettings>('vcon:settings', DEFAULT_SETTINGS)
  );
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [jwtSecret, setJwtSecret] = useState('');
  const [jwtError, setJwtError] = useState('');
  const [confirmRotateOpen, setConfirmRotateOpen] = useState(false);
  const [storagePath, setStoragePath] = useState(() =>
    getCached<string>('vcon:storage-path', '')
  );
  const [baseUrl, setBaseUrl] = useState('');
  const [webSocketUrl, setWebSocketUrl] = useState('');
  const [socketStatus, setSocketStatus] = useState<SocketHealthState>('idle');
  const [activeSockets, setActiveSockets] = useState<number>(0);
  const [serverPort, setServerPort] = useState(() =>
    getCached<number>('vcon:server-port', 4000)
  );
  const [loading, setLoading] = useState(
    () => !getCached<boolean>('vcon:settings-loaded', false)
  );
  const [saving, setSaving] = useState(false);

  const probeSocketServer = useCallback(async (port: number) => {
    setSocketStatus('checking');
    const isLocalHost =
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.port === '3000';
    const httpHost = isLocalHost
      ? `${window.location.hostname}:${port}`
      : window.location.host;
    const healthUrl = `${window.location.protocol}//${httpHost}/health`;

    try {
      const response = await fetch(healthUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(1500),
      });
      setSocketStatus(response.ok ? 'online' : 'offline');
    } catch {
      // In remote/preview environments where Port 4000 is proxied through web API or reverse proxy, probe /api/health
      try {
        const fallbackRes = await fetch('/api/health', {
          cache: 'no-store',
          signal: AbortSignal.timeout(1500),
        });
        setSocketStatus(fallbackRes.ok ? 'online' : 'offline');
      } catch {
        setSocketStatus('offline');
      }
    }
  }, []);

  useEffect(() => {
    setBaseUrl(window.location.origin);
    const isLocalHost =
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.port === '3000';
    const socketProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socketHost = isLocalHost
      ? `${window.location.hostname}:${serverPort}`
      : window.location.host;
    setWebSocketUrl(`${socketProtocol}://${socketHost}`);

    Promise.all([
      fetch('/api/settings', { cache: 'no-store' }).then(async (response) => {
        if (response.status === 401) {
          window.location.assign('/vcon/login');
          return null;
        }
        if (!response.ok) throw new Error('Unable to load settings');
        return response.json();
      }),
      fetch('/api/storage', { cache: 'no-store' }).then(async (response) => {
        if (response.status === 401) {
          window.location.assign('/vcon/login');
          return null;
        }
        if (!response.ok) throw new Error('Unable to load storage information');
        return response.json();
      }),
      fetch('/api/metrics', { cache: 'no-store' })
        .then(async (response) => (response.ok ? response.json() : null))
        .catch(() => null),
    ])
      .then(([settingsData, storageData, metricsData]) => {
        if (!settingsData || !storageData) return;
        const loadedPort = Number(
          (settingsData.settings as PublicSettings).serverPort ?? 4000
        );
        const loaded: EditableSettings = {
          maxEventsPerSec: Number(
            settingsData.settings.maxEventsPerSec ??
              DEFAULT_SETTINGS.maxEventsPerSec
          ),
          maxPayloadSizeKb: Number(
            settingsData.settings.maxPayloadSizeKb ??
              DEFAULT_SETTINGS.maxPayloadSizeKb
          ),
          batchFlushThreshold: Number(
            settingsData.settings.batchFlushThreshold ??
              DEFAULT_SETTINGS.batchFlushThreshold
          ),
          batchFlushIntervalMs: Number(
            settingsData.settings.batchFlushIntervalMs ??
              DEFAULT_SETTINGS.batchFlushIntervalMs
          ),
          fileRotationMb: Number(
            settingsData.settings.fileRotationMb ??
              DEFAULT_SETTINGS.fileRotationMb
          ),
          enableIdempotency: Boolean(
            settingsData.settings.enableIdempotency ??
              DEFAULT_SETTINGS.enableIdempotency
          ),
          autoPruneDays: Number(
            settingsData.settings.autoPruneDays ??
              DEFAULT_SETTINGS.autoPruneDays
          ),
        };
        setSettings(setCached('vcon:settings', loaded));
        setSavedSettings(loaded);
        setServerPort(setCached('vcon:server-port', loadedPort));
        setStoragePath(
          setCached(
            'vcon:storage-path',
            String(storageData.stats?.storageDirectory ?? '')
          )
        );
        if (metricsData && typeof metricsData.activeSockets === 'number') {
          setActiveSockets(metricsData.activeSockets);
          if (metricsData.activeSockets > 0) {
            setSocketStatus('online');
          }
        }
        setCached('vcon:settings-loaded', true);
      })
      .catch(() => {
        error('Settings load failed', 'Using default runtime settings.');
      })
      .finally(() => setLoading(false));
  }, [error, serverPort]);

  const isDirty = useMemo(
    () =>
      jwtSecret.trim().length > 0 ||
      JSON.stringify(settings) !== JSON.stringify(savedSettings),
    [jwtSecret, savedSettings, settings]
  );

  const updateNumber = (key: keyof EditableSettings, value: string) => {
    setSettings((current) => ({ ...current, [key]: Number(value) || 0 }));
  };

  const buildNormalizedSettings = (): EditableSettings => {
    const parsedPrune = Number(settings.autoPruneDays);
    return {
      maxEventsPerSec: Math.max(
        1,
        Math.min(
          10000,
          settings.maxEventsPerSec || DEFAULT_SETTINGS.maxEventsPerSec
        )
      ),
      maxPayloadSizeKb: Math.max(
        1,
        Math.min(
          5120,
          settings.maxPayloadSizeKb || DEFAULT_SETTINGS.maxPayloadSizeKb
        )
      ),
      batchFlushThreshold: Math.max(
        1,
        settings.batchFlushThreshold || DEFAULT_SETTINGS.batchFlushThreshold
      ),
      batchFlushIntervalMs: Math.max(
        100,
        settings.batchFlushIntervalMs || DEFAULT_SETTINGS.batchFlushIntervalMs
      ),
      fileRotationMb: Math.max(
        1,
        settings.fileRotationMb || DEFAULT_SETTINGS.fileRotationMb
      ),
      enableIdempotency: settings.enableIdempotency,
      autoPruneDays: Number.isFinite(parsedPrune)
        ? Math.max(0, Math.min(365, Math.floor(parsedPrune)))
        : DEFAULT_SETTINGS.autoPruneDays,
    };
  };

  const executeSave = async () => {
    const normalized = buildNormalizedSettings();
    const trimmedSecret = jwtSecret.trim();
    setConfirmRotateOpen(false);
    setSaving(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...normalized,
          ...(trimmedSecret ? { jwtSecret: trimmedSecret } : {}),
        }),
      });
      if (response.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Settings update failed');
      setSettings(setCached('vcon:settings', normalized));
      setSavedSettings(normalized);
      setJwtSecret('');
      setJwtError('');
      success(
        'Settings saved',
        trimmedSecret
          ? 'Runtime settings saved and client JWT credentials rotated.'
          : 'Runtime settings updated.'
      );
    } catch (saveError) {
      error(
        'Save failed',
        saveError instanceof Error
          ? saveError.message
          : 'Unable to save settings'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleFormSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedSecret = jwtSecret.trim();
    if (trimmedSecret.length > 0 && trimmedSecret.length < 32) {
      const message = 'JWT secret must be at least 32 characters.';
      setJwtError(message);
      setActiveTab('security');
      error('Invalid JWT secret', message);
      return;
    }

    setJwtError('');
    if (trimmedSecret.length >= 32) {
      setConfirmRotateOpen(true);
      return;
    }

    await executeSave();
  };

  const discardChanges = () => {
    setSettings(savedSettings);
    setJwtSecret('');
    setJwtError('');
  };

  return (
    <PageShell title="Settings">
      <StatStrip
        items={[
          { label: 'Instance', value: 'DataStack', dot: 'ok' },
          { label: 'Rate limit', value: `${settings.maxEventsPerSec} / sec` },
          {
            label: 'Batch flush',
            value: `${settings.batchFlushThreshold} / ${settings.batchFlushIntervalMs}ms`,
          },
          {
            label: 'CSV rotation',
            value: `${settings.fileRotationMb}MB · ${
              settings.autoPruneDays === 0 ? 'Keep all' : `${settings.autoPruneDays}d`
            }`,
          },
        ]}
      />

      <div className="w-full">
        <SettingsTabs
          items={TABS}
          value={activeTab}
          onChange={(tab) => setActiveTab(tab as TabId)}
        />

        <form onSubmit={handleFormSubmit} className="w-full">
          <SettingsPanel
            id={`settings-panel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`settings-tab-${activeTab}`}
          >
            {activeTab === 'general' && (
              <>
                <SettingsGroup title="Identity">
                  <SettingsField label="Instance name">
                    <Input
                      compact
                      value="DataStack"
                      readOnly
                      className="border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]"
                    />
                  </SettingsField>
                  <SettingsField label="Base URL">
                    <Input
                      compact
                      value={baseUrl}
                      readOnly
                      className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text-muted)]"
                    />
                  </SettingsField>
                </SettingsGroup>
                <SettingsGroup title="Throughput">
                  <SettingsField label="Events per second">
                    <Input
                      compact
                      type="number"
                      min="1"
                      max="10000"
                      value={settings.maxEventsPerSec}
                      onChange={(event) =>
                        updateNumber('maxEventsPerSec', event.target.value)
                      }
                    />
                  </SettingsField>
                  <SettingsField label="Idempotency">
                    <FormSwitch
                      label="Deduplicate events"
                      checked={settings.enableIdempotency}
                      onChange={(enableIdempotency) =>
                        setSettings((current) => ({
                          ...current,
                          enableIdempotency,
                        }))
                      }
                    />
                  </SettingsField>
                </SettingsGroup>
              </>
            )}

            {activeTab === 'connections' && (
              <>
                <SettingsGroup title="WebSocket server">
                  <SettingsField label="Live health">
                    <div className="flex items-center justify-between gap-2 border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5">
                      <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px] text-[var(--text)]">
                        <span
                          aria-hidden="true"
                          className={`h-1.5 w-1.5 ${
                            socketStatus === 'online'
                              ? 'bg-[var(--accent)]'
                              : socketStatus === 'checking'
                                ? 'bg-[var(--warning)]'
                                : socketStatus === 'offline'
                                  ? 'bg-[var(--danger)]'
                                  : 'bg-[var(--text-faint)]'
                          }`}
                        />
                        {socketStatus === 'online'
                          ? `Online (Port ${serverPort} · ${activeSockets} active)`
                          : socketStatus === 'checking'
                            ? 'Probing ingestion server...'
                            : socketStatus === 'offline'
                              ? `Offline (Port ${serverPort} unreachable)`
                              : `Port ${serverPort} · ${activeSockets} active socket(s)`}
                      </span>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        icon="RefreshCw"
                        onClick={() => void probeSocketServer(serverPort)}
                      >
                        Probe
                      </Button>
                    </div>
                  </SettingsField>
                  <SettingsField label="WebSocket URL">
                    <Input
                      compact
                      value={webSocketUrl}
                      readOnly
                      className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text-muted)]"
                    />
                  </SettingsField>
                  <SettingsField label="Socket port">
                    <Input
                      compact
                      type="number"
                      value={serverPort}
                      readOnly
                      className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[var(--text-muted)]"
                    />
                  </SettingsField>
                </SettingsGroup>
                <SettingsGroup title="Event buffer">
                  <SettingsField label="Batch flush threshold">
                    <Input
                      compact
                      type="number"
                      min="1"
                      value={settings.batchFlushThreshold}
                      onChange={(event) =>
                        updateNumber('batchFlushThreshold', event.target.value)
                      }
                    />
                  </SettingsField>
                  <SettingsField label="Flush interval">
                    <Input
                      compact
                      type="number"
                      min="100"
                      suffix="ms"
                      value={settings.batchFlushIntervalMs}
                      onChange={(event) =>
                        updateNumber('batchFlushIntervalMs', event.target.value)
                      }
                      className="font-mono"
                    />
                  </SettingsField>
                </SettingsGroup>
              </>
            )}

            {activeTab === 'storage' && (
              <>
                <SettingsGroup title="CSV files">
                  <SettingsField label="Root path">
                    <Input
                      compact
                      value={storagePath || 'Unavailable'}
                      readOnly
                      className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text-muted)]"
                    />
                  </SettingsField>
                  <SettingsField label="File rotation">
                    <Input
                      compact
                      type="number"
                      min="1"
                      suffix="MB"
                      value={settings.fileRotationMb}
                      onChange={(event) =>
                        updateNumber('fileRotationMb', event.target.value)
                      }
                      className="font-mono"
                    />
                  </SettingsField>
                  <SettingsField label="Retention (0 = never prune)">
                    <Input
                      compact
                      type="number"
                      min="0"
                      max="365"
                      suffix="days"
                      value={settings.autoPruneDays}
                      onChange={(event) =>
                        updateNumber('autoPruneDays', event.target.value)
                      }
                      className="font-mono"
                    />
                  </SettingsField>
                </SettingsGroup>
                <SettingsGroup title="Schema">
                  <SettingsField label="Row format">
                    <Input
                      compact
                      value="clientId, eventId, timestamp, payload"
                      readOnly
                      className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text-muted)]"
                    />
                  </SettingsField>
                </SettingsGroup>
              </>
            )}

            {activeTab === 'security' && (
              <SettingsGroup title="Authentication">
                <SettingsField label="JWT secret (min 32 chars)">
                  <Input
                    compact
                    type="password"
                    autoComplete="new-password"
                    value={jwtSecret}
                    error={jwtError}
                    onChange={(event) => {
                      const val = event.target.value;
                      setJwtSecret(val);
                      if (!val.trim() || val.trim().length >= 32) {
                        setJwtError('');
                      }
                    }}
                    placeholder="Minimum 32 characters to rotate..."
                  />
                </SettingsField>
                <SettingsField label="Payload size limit">
                  <Input
                    compact
                    type="number"
                    min="1"
                    max="5120"
                    suffix="KB"
                    value={settings.maxPayloadSizeKb}
                    onChange={(event) =>
                      updateNumber('maxPayloadSizeKb', event.target.value)
                    }
                    className="font-mono"
                  />
                </SettingsField>
              </SettingsGroup>
            )}

            <SettingsFooter
              status={
                <>
                  <span
                    className={`h-1.5 w-1.5 ${
                      isDirty ? 'bg-[var(--warning)]' : 'bg-[var(--accent)]'
                    }`}
                  />
                  <span>
                    {loading ? 'Loading' : isDirty ? 'Unsaved changes' : 'Saved'}
                  </span>
                </>
              }
            >
              <Button
                type="button"
                size="xs"
                disabled={!isDirty || saving}
                onClick={discardChanges}
              >
                Discard
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="xs"
                icon="Save"
                loading={saving}
                disabled={loading || !isDirty}
              >
                Save
              </Button>
            </SettingsFooter>
          </SettingsPanel>
        </form>
      </div>

      <Modal
        isOpen={confirmRotateOpen}
        onClose={() => !saving && setConfirmRotateOpen(false)}
        title="Confirm JWT secret rotation"
        maxWidth="xs"
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={saving}
              onClick={() => setConfirmRotateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              size="xs"
              loading={saving}
              onClick={() => void executeSave()}
            >
              Rotate & Save
            </Button>
          </>
        }
      >
        <p className="text-[12px] text-[var(--text-muted)]">
          Rotating the signing JWT secret will immediately re-sign registered client tokens and invalidate all older SDK JWT tokens and active WebSocket sessions. Continue?
        </p>
      </Modal>
    </PageShell>
  );
}
