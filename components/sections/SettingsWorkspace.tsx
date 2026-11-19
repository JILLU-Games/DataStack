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
import {
  DEFAULT_EDITABLE_SETTINGS,
  describeSettingsBridgeSync,
  type EditableSettings,
  mapBridgeStatusToSocketUiState,
  normalizeEditableSettings,
  NUMERIC_SETTING_KEYS,
  type NumericSettingDrafts,
  type NumericSettingKey,
  resolvePublicEndpoints,
  SETTINGS_LIMITS,
  settingsToNumericDrafts,
  type SettingsValidationErrors,
  type SocketHealthUiState,
  validateEditableSettingsDraft,
  validateSingleNumericSetting,
} from '@/lib/vconUiHelpers';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface PublicSettings extends EditableSettings {
  serverPort: number;
  webPort: number;
  updatedAt: string;
}

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'connections', label: 'Connections' },
  { id: 'storage', label: 'Storage' },
  { id: 'security', label: 'Security' },
];

type TabId = (typeof TABS)[number]['id'];

const FIELD_TO_TAB: Record<NumericSettingKey, TabId> = {
  maxEventsPerSec: 'general',
  batchFlushThreshold: 'connections',
  batchFlushIntervalMs: 'connections',
  fileRotationMb: 'storage',
  autoPruneDays: 'storage',
  maxPayloadSizeKb: 'security',
};

export function SettingsWorkspace() {
  const { success, warning, error } = useToast();
  const [savedSettings, setSavedSettings] = useState<EditableSettings>(() =>
    getCached<EditableSettings>('vcon:settings', DEFAULT_EDITABLE_SETTINGS)
  );
  const [numericDrafts, setNumericDrafts] = useState<NumericSettingDrafts>(() =>
    settingsToNumericDrafts(
      getCached<EditableSettings>('vcon:settings', DEFAULT_EDITABLE_SETTINGS)
    )
  );
  const [enableIdempotency, setEnableIdempotency] = useState<boolean>(
    () =>
      getCached<EditableSettings>('vcon:settings', DEFAULT_EDITABLE_SETTINGS)
        .enableIdempotency
  );
  const [fieldErrors, setFieldErrors] = useState<SettingsValidationErrors>({});
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [jwtSecret, setJwtSecret] = useState('');
  const [jwtError, setJwtError] = useState('');
  const [confirmRotateOpen, setConfirmRotateOpen] = useState(false);
  const [storagePath, setStoragePath] = useState(() =>
    getCached<string>('vcon:storage-path', '')
  );
  const [baseUrl, setBaseUrl] = useState('');
  const [socketStatus, setSocketStatus] = useState<SocketHealthUiState>('idle');
  const [bridgeError, setBridgeError] = useState('');
  const [activeSockets, setActiveSockets] = useState<number>(0);
  const [serverPort, setServerPort] = useState(() =>
    getCached<number>('vcon:server-port', 4000)
  );
  const [loading, setLoading] = useState(
    () => !getCached<boolean>('vcon:settings-loaded', false)
  );
  const [saving, setSaving] = useState(false);

  const webSocketUrl = useMemo(() => {
    if (!baseUrl || typeof window === 'undefined') return '';
    return resolvePublicEndpoints(window.location, serverPort).webSocketUrl;
  }, [baseUrl, serverPort]);

  const probeSocketServer = useCallback(async () => {
    setSocketStatus('checking');
    try {
      const response = await fetch('/api/metrics', {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      });
      if (response.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      if (!response.ok) {
        setSocketStatus('offline');
        setBridgeError(`Metrics probe returned HTTP ${response.status}`);
        return;
      }
      const metricsData = await response.json();
      const runtimePort = Number(metricsData?.runtime?.serverPort);
      if (Number.isFinite(runtimePort) && runtimePort > 0) {
        setServerPort(setCached('vcon:server-port', runtimePort));
      }
      setActiveSockets(Number(metricsData?.activeSockets) || 0);
      const nextState = mapBridgeStatusToSocketUiState(
        metricsData?.runtime?.ingestionBridgeStatus
      );
      setSocketStatus(nextState);
      setBridgeError(String(metricsData?.runtime?.ingestionBridgeError || ''));
    } catch {
      setSocketStatus('offline');
      setBridgeError('Unable to reach /api/metrics bridge probe');
    }
  }, []);

  useEffect(() => {
    setBaseUrl(window.location.origin);

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
        .then(async (response) => {
          if (response.status === 401) {
            window.location.assign('/vcon/login');
            return null;
          }
          return response.ok ? response.json() : null;
        })
        .catch(() => null),
    ])
      .then(([settingsData, storageData, metricsData]) => {
        if (!settingsData || !storageData) return;
        const runtimePort = Number(metricsData?.runtime?.serverPort);
        const settingsPort = Number(
          (settingsData.settings as PublicSettings).serverPort ?? 4000
        );
        const loadedPort =
          Number.isFinite(runtimePort) && runtimePort > 0 ? runtimePort : settingsPort;
        const loaded: EditableSettings = {
          maxEventsPerSec: Number(
            settingsData.settings.maxEventsPerSec ??
              DEFAULT_EDITABLE_SETTINGS.maxEventsPerSec
          ),
          maxPayloadSizeKb: Number(
            settingsData.settings.maxPayloadSizeKb ??
              DEFAULT_EDITABLE_SETTINGS.maxPayloadSizeKb
          ),
          batchFlushThreshold: Number(
            settingsData.settings.batchFlushThreshold ??
              DEFAULT_EDITABLE_SETTINGS.batchFlushThreshold
          ),
          batchFlushIntervalMs: Number(
            settingsData.settings.batchFlushIntervalMs ??
              DEFAULT_EDITABLE_SETTINGS.batchFlushIntervalMs
          ),
          fileRotationMb: Number(
            settingsData.settings.fileRotationMb ??
              DEFAULT_EDITABLE_SETTINGS.fileRotationMb
          ),
          enableIdempotency: Boolean(
            settingsData.settings.enableIdempotency ??
              DEFAULT_EDITABLE_SETTINGS.enableIdempotency
          ),
          autoPruneDays: Number(
            settingsData.settings.autoPruneDays ??
              DEFAULT_EDITABLE_SETTINGS.autoPruneDays
          ),
        };
        const cachedLoaded = setCached('vcon:settings', loaded);
        setSavedSettings(cachedLoaded);
        setNumericDrafts(settingsToNumericDrafts(cachedLoaded));
        setEnableIdempotency(cachedLoaded.enableIdempotency);
        setFieldErrors({});
        setServerPort(setCached('vcon:server-port', loadedPort));
        setStoragePath(
          setCached(
            'vcon:storage-path',
            String(storageData.stats?.storageDirectory ?? '')
          )
        );
        if (metricsData) {
          setActiveSockets(Number(metricsData.activeSockets) || 0);
          setSocketStatus(
            mapBridgeStatusToSocketUiState(
              metricsData.runtime?.ingestionBridgeStatus
            )
          );
          setBridgeError(String(metricsData.runtime?.ingestionBridgeError || ''));
        }
        setCached('vcon:settings-loaded', true);
      })
      .catch(() => {
        error('Settings load failed', 'Using last cached runtime settings.');
      })
      .finally(() => setLoading(false));
  }, [error]);

  const isDirty = useMemo(
    () =>
      jwtSecret.trim().length > 0 ||
      enableIdempotency !== savedSettings.enableIdempotency ||
      NUMERIC_SETTING_KEYS.some(
        (key) => numericDrafts[key].trim() !== String(savedSettings[key])
      ),
    [enableIdempotency, jwtSecret, numericDrafts, savedSettings]
  );

  const updateNumberDraft = (key: NumericSettingKey, value: string) => {
    setNumericDrafts((current) => ({
      ...current,
      [key]: value,
    }));
    const check = validateSingleNumericSetting(key, value);
    setFieldErrors((current) => {
      if (check.valid) {
        if (!current[key]) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      return { ...current, [key]: check.error };
    });
  };

  const executeSave = async (validated: EditableSettings) => {
    const trimmedSecret = jwtSecret.trim();
    setConfirmRotateOpen(false);
    setSaving(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validated,
          ...(trimmedSecret ? { jwtSecret: trimmedSecret } : {}),
        }),
      });
      if (response.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Settings update failed');
      const synced = normalizeEditableSettings(data.settings ?? validated);
      setCached('vcon:settings', synced);
      setSavedSettings(synced);
      setNumericDrafts(settingsToNumericDrafts(synced));
      setEnableIdempotency(synced.enableIdempotency);
      setFieldErrors({});
      setJwtSecret('');
      setJwtError('');

      const bridgeSummary = describeSettingsBridgeSync(data.bridgeSync);
      if (bridgeSummary.level === 'error') {
        setSocketStatus('auth_error');
        setBridgeError(bridgeSummary.message || '');
        error(bridgeSummary.title, bridgeSummary.message);
      } else if (bridgeSummary.level === 'warning') {
        setSocketStatus('offline');
        setBridgeError(bridgeSummary.message || '');
        warning(bridgeSummary.title, bridgeSummary.message);
      } else {
        if (Boolean(data.bridgeSync?.ok ?? data.bridgeSync?.synced)) {
          setSocketStatus('online');
          setBridgeError('');
        }
        success(
          'Settings saved',
          trimmedSecret
            ? 'Runtime settings saved and client JWT credentials rotated.'
            : 'Runtime settings updated across Web & Ingestion.'
        );
      }
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
    const validation = validateEditableSettingsDraft(
      numericDrafts,
      enableIdempotency
    );
    if (!validation.valid || !validation.values) {
      setFieldErrors(validation.errors);
      if (validation.firstInvalidKey) {
        setActiveTab(FIELD_TO_TAB[validation.firstInvalidKey]);
      }
      const firstMessage =
        (validation.firstInvalidKey &&
          validation.errors[validation.firstInvalidKey]) ||
        'Review highlighted numeric settings before saving.';
      error('Invalid setting value', firstMessage);
      return;
    }

    setFieldErrors({});
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

    await executeSave(validation.values);
  };

  const handleConfirmedRotateSave = async () => {
    const validation = validateEditableSettingsDraft(
      numericDrafts,
      enableIdempotency
    );
    if (!validation.valid || !validation.values) {
      setConfirmRotateOpen(false);
      setFieldErrors(validation.errors);
      if (validation.firstInvalidKey) {
        setActiveTab(FIELD_TO_TAB[validation.firstInvalidKey]);
      }
      return;
    }
    await executeSave(validation.values);
  };

  const discardChanges = () => {
    setNumericDrafts(settingsToNumericDrafts(savedSettings));
    setEnableIdempotency(savedSettings.enableIdempotency);
    setFieldErrors({});
    setJwtSecret('');
    setJwtError('');
  };

  const rateLimitStat = numericDrafts.maxEventsPerSec.trim() || '—';
  const flushThresholdStat = numericDrafts.batchFlushThreshold.trim() || '—';
  const flushIntervalStat = numericDrafts.batchFlushIntervalMs.trim() || '—';
  const rotationStat = numericDrafts.fileRotationMb.trim() || '—';
  const pruneStat =
    numericDrafts.autoPruneDays.trim() === '0'
      ? 'Keep all'
      : numericDrafts.autoPruneDays.trim()
        ? `${numericDrafts.autoPruneDays.trim()}d`
        : '—';

  return (
    <PageShell title="Settings">
      <StatStrip
        items={[
          { label: 'Instance', value: 'DataStack', dot: 'ok' },
          { label: 'Rate limit', value: `${rateLimitStat} / sec` },
          {
            label: 'Batch flush',
            value: `${flushThresholdStat} / ${flushIntervalStat}ms`,
          },
          {
            label: 'CSV rotation',
            value: `${rotationStat}MB · ${pruneStat}`,
          },
        ]}
      />

      <div className="w-full">
        <SettingsTabs
          items={TABS}
          value={activeTab}
          onChange={(tab) => setActiveTab(tab as TabId)}
        />

        <form onSubmit={handleFormSubmit} noValidate className="w-full">
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
                      min={SETTINGS_LIMITS.maxEventsPerSec.min}
                      max={SETTINGS_LIMITS.maxEventsPerSec.max}
                      value={numericDrafts.maxEventsPerSec}
                      error={fieldErrors.maxEventsPerSec}
                      onChange={(event) =>
                        updateNumberDraft('maxEventsPerSec', event.target.value)
                      }
                    />
                  </SettingsField>
                  <SettingsField label="Idempotency">
                    <FormSwitch
                      label="Deduplicate events"
                      checked={enableIdempotency}
                      onChange={setEnableIdempotency}
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
                      <span
                        className="inline-flex items-center gap-1.5 font-mono text-[11.5px] text-[var(--text)]"
                        title={bridgeError || undefined}
                      >
                        <span
                          aria-hidden="true"
                          className={`h-1.5 w-1.5 ${
                            socketStatus === 'online'
                              ? 'bg-[var(--accent)]'
                              : socketStatus === 'checking'
                                ? 'bg-[var(--warning)]'
                                : socketStatus === 'auth_error' || socketStatus === 'offline'
                                  ? 'bg-[var(--danger)]'
                                  : 'bg-[var(--text-faint)]'
                          }`}
                        />
                        {socketStatus === 'online'
                          ? `Online (Port ${serverPort} · ${activeSockets} active)`
                          : socketStatus === 'checking'
                            ? 'Probing ingestion bridge...'
                            : socketStatus === 'auth_error'
                              ? `Bridge Auth Error (Port ${serverPort})`
                              : socketStatus === 'offline'
                                ? `Offline (Port ${serverPort} unreachable)`
                                : `Port ${serverPort} · ${activeSockets} active socket(s)`}
                      </span>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        icon="RefreshCw"
                        onClick={() => void probeSocketServer()}
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
                  <SettingsField label="Socket port (PORT_SOCKET)">
                    <div className="flex flex-col gap-1">
                      <Input
                        compact
                        value={String(serverPort)}
                        readOnly
                        className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text-muted)]"
                      />
                      <span className="text-[10.5px] text-[var(--text-faint)]">
                        Read-only runtime port managed via PORT_SOCKET environment variable.
                      </span>
                    </div>
                  </SettingsField>
                </SettingsGroup>
                <SettingsGroup title="Event buffer">
                  <SettingsField label="Batch flush threshold">
                    <Input
                      compact
                      type="number"
                      min={SETTINGS_LIMITS.batchFlushThreshold.min}
                      max={SETTINGS_LIMITS.batchFlushThreshold.max}
                      value={numericDrafts.batchFlushThreshold}
                      error={fieldErrors.batchFlushThreshold}
                      onChange={(event) =>
                        updateNumberDraft('batchFlushThreshold', event.target.value)
                      }
                    />
                  </SettingsField>
                  <SettingsField label="Flush interval">
                    <Input
                      compact
                      type="number"
                      min={SETTINGS_LIMITS.batchFlushIntervalMs.min}
                      max={SETTINGS_LIMITS.batchFlushIntervalMs.max}
                      suffix="ms"
                      value={numericDrafts.batchFlushIntervalMs}
                      error={fieldErrors.batchFlushIntervalMs}
                      onChange={(event) =>
                        updateNumberDraft('batchFlushIntervalMs', event.target.value)
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
                      min={SETTINGS_LIMITS.fileRotationMb.min}
                      max={SETTINGS_LIMITS.fileRotationMb.max}
                      suffix="MB"
                      value={numericDrafts.fileRotationMb}
                      error={fieldErrors.fileRotationMb}
                      onChange={(event) =>
                        updateNumberDraft('fileRotationMb', event.target.value)
                      }
                      className="font-mono"
                    />
                  </SettingsField>
                  <SettingsField label="Retention (0 = never prune)">
                    <Input
                      compact
                      type="number"
                      min={SETTINGS_LIMITS.autoPruneDays.min}
                      max={SETTINGS_LIMITS.autoPruneDays.max}
                      suffix="days"
                      value={numericDrafts.autoPruneDays}
                      error={fieldErrors.autoPruneDays}
                      onChange={(event) =>
                        updateNumberDraft('autoPruneDays', event.target.value)
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
                    min={SETTINGS_LIMITS.maxPayloadSizeKb.min}
                    max={SETTINGS_LIMITS.maxPayloadSizeKb.max}
                    suffix="KB"
                    value={numericDrafts.maxPayloadSizeKb}
                    error={fieldErrors.maxPayloadSizeKb}
                    onChange={(event) =>
                      updateNumberDraft('maxPayloadSizeKb', event.target.value)
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
              onClick={() => void handleConfirmedRotateSave()}
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
