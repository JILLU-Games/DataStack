'use client';

import { PageShell } from '@/components/layout/PageShell';
import { useVconRole } from '@/components/layout/VconShell';
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
  type AlertingAndMetricsSettingsFields,
  DEFAULT_ALERTING_SETTINGS,
  DEFAULT_EDITABLE_SETTINGS,
  DEFAULT_S3_SETTINGS,
  describeSettingsBridgeSync,
  type EditableSettings,
  getVconRoleCapabilities,
  mapBridgeStatusToSocketUiState,
  normalizeAlertingSettings,
  normalizeEditableSettings,
  normalizeS3Settings,
  NUMERIC_SETTING_KEYS,
  type NumericSettingDrafts,
  type NumericSettingKey,
  resolvePublicEndpoints,
  type S3SettingsFields,
  SETTINGS_LIMITS,
  settingsToNumericDrafts,
  type SettingsValidationErrors,
  type SocketHealthUiState,
  validateEditableSettingsDraft,
  validateSingleNumericSetting,
} from '@/lib/vconUiHelpers';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface PublicSettings
  extends EditableSettings,
    S3SettingsFields,
    AlertingAndMetricsSettingsFields {
  serverPort: number;
  webPort: number;
  hasS3SecretKey?: boolean;
  s3SecretKeyMask?: string;
  hasWebhookSecret?: boolean;
  webhookSecretMask?: string;
  hasPrometheusToken?: boolean;
  prometheusTokenMask?: string;
  updatedAt: string;
}

interface DiskUsageSummary {
  available?: boolean;
  usedPct: number;
  freeBytes?: number;
  availableBytes?: number;
  totalBytes: number;
  checkedAt?: string | number;
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
  compressAfterDays: 'storage',
  diskPauseThresholdPct: 'storage',
  maxPayloadSizeKb: 'security',
  webhookCooldownSec: 'security',
};

function formatGiB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0.0 GB';
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function SettingsWorkspace() {
  const currentRole = useVconRole();
  const { canAdminSettings, canOperate } = getVconRoleCapabilities(currentRole);
  const { success, warning, error } = useToast();
  const [savedSettings, setSavedSettings] = useState<EditableSettings>(() =>
    normalizeEditableSettings(
      getCached<Partial<EditableSettings>>('vcon:settings', DEFAULT_EDITABLE_SETTINGS)
    )
  );
  const [numericDrafts, setNumericDrafts] = useState<NumericSettingDrafts>(() =>
    settingsToNumericDrafts(
      normalizeEditableSettings(
        getCached<Partial<EditableSettings>>('vcon:settings', DEFAULT_EDITABLE_SETTINGS)
      )
    )
  );
  const [enableIdempotency, setEnableIdempotency] = useState<boolean>(
    () =>
      normalizeEditableSettings(
        getCached<Partial<EditableSettings>>('vcon:settings', DEFAULT_EDITABLE_SETTINGS)
      ).enableIdempotency
  );
  const [savedS3Settings, setSavedS3Settings] = useState<S3SettingsFields>(() =>
    normalizeS3Settings(
      getCached<Partial<S3SettingsFields>>('vcon:s3-settings', DEFAULT_S3_SETTINGS)
    )
  );
  const [s3Draft, setS3Draft] = useState<S3SettingsFields>(() =>
    normalizeS3Settings(
      getCached<Partial<S3SettingsFields>>('vcon:s3-settings', DEFAULT_S3_SETTINGS)
    )
  );
  const [hasS3SecretKey, setHasS3SecretKey] = useState(false);
  const [s3SecretKeyMask, setS3SecretKeyMask] = useState('');
  const [s3SecretAccessKey, setS3SecretAccessKey] = useState('');
  const [clearS3SecretKey, setClearS3SecretKey] = useState(false);
  const [savedAlertingSettings, setSavedAlertingSettings] =
    useState<AlertingAndMetricsSettingsFields>(() =>
      normalizeAlertingSettings(
        getCached<Partial<AlertingAndMetricsSettingsFields>>(
          'vcon:alerting-settings',
          DEFAULT_ALERTING_SETTINGS
        )
      )
    );
  const [alertingDraft, setAlertingDraft] =
    useState<AlertingAndMetricsSettingsFields>(() =>
      normalizeAlertingSettings(
        getCached<Partial<AlertingAndMetricsSettingsFields>>(
          'vcon:alerting-settings',
          DEFAULT_ALERTING_SETTINGS
        )
      )
    );
  const [hasWebhookSecret, setHasWebhookSecret] = useState(false);
  const [webhookSecretMask, setWebhookSecretMask] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [clearWebhookSecret, setClearWebhookSecret] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState(false);
  const [webhookTestStatus, setWebhookTestStatus] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [hasPrometheusToken, setHasPrometheusToken] = useState(false);
  const [prometheusTokenMask, setPrometheusTokenMask] = useState('');
  const [prometheusMetricsToken, setPrometheusMetricsToken] = useState('');
  const [clearPrometheusToken, setClearPrometheusToken] = useState(false);
  const [diskUsage, setDiskUsage] = useState<DiskUsageSummary | null>(null);
  const [testingS3, setTestingS3] = useState(false);
  const [archivingNow, setArchivingNow] = useState(false);
  const [s3ActionStatus, setS3ActionStatus] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
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
        const rawSettings = settingsData.settings as PublicSettings;
        const loaded: EditableSettings = {
          maxEventsPerSec: Number(
            rawSettings.maxEventsPerSec ??
              DEFAULT_EDITABLE_SETTINGS.maxEventsPerSec
          ),
          maxPayloadSizeKb: Number(
            rawSettings.maxPayloadSizeKb ??
              DEFAULT_EDITABLE_SETTINGS.maxPayloadSizeKb
          ),
          batchFlushThreshold: Number(
            rawSettings.batchFlushThreshold ??
              DEFAULT_EDITABLE_SETTINGS.batchFlushThreshold
          ),
          batchFlushIntervalMs: Number(
            rawSettings.batchFlushIntervalMs ??
              DEFAULT_EDITABLE_SETTINGS.batchFlushIntervalMs
          ),
          fileRotationMb: Number(
            rawSettings.fileRotationMb ??
              DEFAULT_EDITABLE_SETTINGS.fileRotationMb
          ),
          enableIdempotency: Boolean(
            rawSettings.enableIdempotency ??
              DEFAULT_EDITABLE_SETTINGS.enableIdempotency
          ),
          autoPruneDays: Number(
            rawSettings.autoPruneDays ??
              DEFAULT_EDITABLE_SETTINGS.autoPruneDays
          ),
          compressAfterDays: Number(
            rawSettings.compressAfterDays ??
              DEFAULT_EDITABLE_SETTINGS.compressAfterDays
          ),
          diskPauseThresholdPct: Number(
            rawSettings.diskPauseThresholdPct ??
              DEFAULT_EDITABLE_SETTINGS.diskPauseThresholdPct
          ),
          webhookCooldownSec: Number(
            rawSettings.webhookCooldownSec ??
              DEFAULT_EDITABLE_SETTINGS.webhookCooldownSec
          ),
        };
        const loadedS3 = normalizeS3Settings(rawSettings);
        const loadedAlerting = normalizeAlertingSettings(rawSettings);
        const cachedLoaded = setCached('vcon:settings', normalizeEditableSettings(loaded));
        const cachedS3 = setCached('vcon:s3-settings', loadedS3);
        const cachedAlerting = setCached('vcon:alerting-settings', loadedAlerting);
        setSavedSettings(cachedLoaded);
        setNumericDrafts(settingsToNumericDrafts(cachedLoaded));
        setEnableIdempotency(cachedLoaded.enableIdempotency);
        setSavedS3Settings(cachedS3);
        setS3Draft(cachedS3);
        setHasS3SecretKey(Boolean(rawSettings.hasS3SecretKey));
        setS3SecretKeyMask(String(rawSettings.s3SecretKeyMask || ''));
        setS3SecretAccessKey('');
        setClearS3SecretKey(false);
        setSavedAlertingSettings(cachedAlerting);
        setAlertingDraft(cachedAlerting);
        setHasWebhookSecret(Boolean(rawSettings.hasWebhookSecret));
        setWebhookSecretMask(String(rawSettings.webhookSecretMask || ''));
        setWebhookSecret('');
        setClearWebhookSecret(false);
        setHasPrometheusToken(Boolean(rawSettings.hasPrometheusToken));
        setPrometheusTokenMask(String(rawSettings.prometheusTokenMask || ''));
        setPrometheusMetricsToken('');
        setClearPrometheusToken(false);
        setFieldErrors({});
        setServerPort(setCached('vcon:server-port', loadedPort));
        setStoragePath(
          setCached(
            'vcon:storage-path',
            String(storageData.stats?.storageDirectory ?? '')
          )
        );
        if (storageData.diskUsage && typeof storageData.diskUsage === 'object') {
          const rawDisk = storageData.diskUsage as DiskUsageSummary;
          const totalBytes = Number(rawDisk.totalBytes) || 0;
          const freeBytes = Number(rawDisk.freeBytes ?? rawDisk.availableBytes) || 0;
          setDiskUsage({
            ...rawDisk,
            available:
              rawDisk.available !== undefined
                ? Boolean(rawDisk.available)
                : totalBytes > 0,
            usedPct: Number(rawDisk.usedPct) || 0,
            freeBytes,
            availableBytes: freeBytes,
            totalBytes,
          });
        }
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

  const s3ConfigDirty = useMemo(
    () =>
      s3Draft.enableS3Backup !== savedS3Settings.enableS3Backup ||
      s3Draft.s3Endpoint.trim() !== savedS3Settings.s3Endpoint ||
      (s3Draft.s3Region.trim() || 'auto') !== (savedS3Settings.s3Region || 'auto') ||
      s3Draft.s3Bucket.trim() !== savedS3Settings.s3Bucket ||
      s3Draft.s3Prefix.trim() !== savedS3Settings.s3Prefix ||
      s3Draft.s3AccessKeyId.trim() !== savedS3Settings.s3AccessKeyId ||
      s3SecretAccessKey.trim().length > 0 ||
      clearS3SecretKey,
    [clearS3SecretKey, s3Draft, s3SecretAccessKey, savedS3Settings]
  );

  const alertingConfigDirty = useMemo(
    () =>
      alertingDraft.enableWebhookAlerts !==
        savedAlertingSettings.enableWebhookAlerts ||
      alertingDraft.webhookUrl.trim() !== savedAlertingSettings.webhookUrl ||
      webhookSecret.trim().length > 0 ||
      clearWebhookSecret ||
      alertingDraft.enablePrometheusMetrics !==
        savedAlertingSettings.enablePrometheusMetrics ||
      prometheusMetricsToken.trim().length > 0 ||
      clearPrometheusToken,
    [
      alertingDraft,
      clearPrometheusToken,
      clearWebhookSecret,
      prometheusMetricsToken,
      savedAlertingSettings,
      webhookSecret,
    ]
  );

  const isDirty = useMemo(
    () =>
      jwtSecret.trim().length > 0 ||
      enableIdempotency !== savedSettings.enableIdempotency ||
      s3ConfigDirty ||
      alertingConfigDirty ||
      NUMERIC_SETTING_KEYS.some(
        (key) => numericDrafts[key].trim() !== String(savedSettings[key])
      ),
    [
      alertingConfigDirty,
      enableIdempotency,
      jwtSecret,
      numericDrafts,
      s3ConfigDirty,
      savedSettings,
    ]
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
    const normalizedS3 = normalizeS3Settings(s3Draft);
    const trimmedS3Secret = s3SecretAccessKey.trim();
    const normalizedAlerting = normalizeAlertingSettings(alertingDraft);
    const trimmedWebhookSecret = webhookSecret.trim();
    const trimmedPrometheusToken = prometheusMetricsToken.trim();
    setConfirmRotateOpen(false);
    setSaving(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validated,
          enableS3Backup: normalizedS3.enableS3Backup,
          s3Endpoint: normalizedS3.s3Endpoint,
          s3Region: normalizedS3.s3Region,
          s3Bucket: normalizedS3.s3Bucket,
          s3Prefix: normalizedS3.s3Prefix,
          s3AccessKeyId: normalizedS3.s3AccessKeyId,
          ...(trimmedS3Secret
            ? { s3SecretAccessKey: trimmedS3Secret }
            : clearS3SecretKey
              ? { clearS3SecretKey: true }
              : {}),
          enableWebhookAlerts: normalizedAlerting.enableWebhookAlerts,
          webhookUrl: normalizedAlerting.webhookUrl,
          ...(trimmedWebhookSecret
            ? { webhookSecret: trimmedWebhookSecret }
            : clearWebhookSecret
              ? { clearWebhookSecret: true }
              : {}),
          enablePrometheusMetrics: normalizedAlerting.enablePrometheusMetrics,
          ...(trimmedPrometheusToken
            ? { prometheusMetricsToken: trimmedPrometheusToken }
            : clearPrometheusToken
              ? { clearPrometheusToken: true }
              : {}),
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
      const syncedS3 = normalizeS3Settings(data.settings ?? normalizedS3);
      const syncedAlerting = normalizeAlertingSettings(
        data.settings ?? normalizedAlerting
      );
      setCached('vcon:settings', synced);
      setCached('vcon:s3-settings', syncedS3);
      setCached('vcon:alerting-settings', syncedAlerting);
      setSavedSettings(synced);
      setNumericDrafts(settingsToNumericDrafts(synced));
      setEnableIdempotency(synced.enableIdempotency);
      setSavedS3Settings(syncedS3);
      setS3Draft(syncedS3);
      setHasS3SecretKey(Boolean(data.settings?.hasS3SecretKey));
      setS3SecretKeyMask(String(data.settings?.s3SecretKeyMask || ''));
      setS3SecretAccessKey('');
      setClearS3SecretKey(false);
      setSavedAlertingSettings(syncedAlerting);
      setAlertingDraft(syncedAlerting);
      setHasWebhookSecret(Boolean(data.settings?.hasWebhookSecret));
      setWebhookSecretMask(String(data.settings?.webhookSecretMask || ''));
      setWebhookSecret('');
      setClearWebhookSecret(false);
      setHasPrometheusToken(Boolean(data.settings?.hasPrometheusToken));
      setPrometheusTokenMask(String(data.settings?.prometheusTokenMask || ''));
      setPrometheusMetricsToken('');
      setClearPrometheusToken(false);
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

  const handleTestWebhookAlert = async () => {
    if (!canAdminSettings) return;
    setTestingWebhook(true);
    setWebhookTestStatus(null);
    try {
      const normalizedAlerting = normalizeAlertingSettings(alertingDraft);
      const trimmedWebhookSecret = webhookSecret.trim();
      const response = await fetch('/api/settings/webhook-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: normalizedAlerting.webhookUrl,
          ...(trimmedWebhookSecret ? { webhookSecret: trimmedWebhookSecret } : {}),
          ...(clearWebhookSecret ? { clearWebhookSecret: true } : {}),
        }),
      });
      if (response.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        const msg = String(data.error || 'Webhook test alert failed.');
        setWebhookTestStatus({ ok: false, text: msg });
        error('Webhook test failed', msg);
        return;
      }
      const msg = `Test alert delivered (HTTP ${data.status}).`;
      setWebhookTestStatus({ ok: true, text: msg });
      success('Webhook alert delivered', msg);
    } catch (testErr) {
      const msg =
        testErr instanceof Error ? testErr.message : 'Webhook test alert failed.';
      setWebhookTestStatus({ ok: false, text: msg });
      error('Webhook test error', msg);
    } finally {
      setTestingWebhook(false);
    }
  };

  const handleTestS3Connection = async () => {
    if (!canAdminSettings) return;
    setTestingS3(true);
    setS3ActionStatus(null);
    try {
      const normalizedS3 = normalizeS3Settings(s3Draft);
      const trimmedS3Secret = s3SecretAccessKey.trim();
      const response = await fetch('/api/storage/s3-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          s3Endpoint: normalizedS3.s3Endpoint,
          s3Region: normalizedS3.s3Region,
          s3Bucket: normalizedS3.s3Bucket,
          s3Prefix: normalizedS3.s3Prefix,
          s3AccessKeyId: normalizedS3.s3AccessKeyId,
          ...(trimmedS3Secret ? { s3SecretAccessKey: trimmedS3Secret } : {}),
          ...(clearS3SecretKey ? { clearS3SecretKey: true } : {}),
        }),
      });
      if (response.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        const msg = String(data.error || 'S3 connection check failed.');
        setS3ActionStatus({ ok: false, text: msg });
        error('S3 test failed', msg);
        return;
      }
      const msg = `Connected to bucket "${data.bucket}" (HTTP ${data.status}).`;
      setS3ActionStatus({ ok: true, text: msg });
      success('S3 connection verified', msg);
    } catch (testErr) {
      const msg =
        testErr instanceof Error ? testErr.message : 'S3 connection check failed.';
      setS3ActionStatus({ ok: false, text: msg });
      error('S3 test error', msg);
    } finally {
      setTestingS3(false);
    }
  };

  const handleArchiveNow = async () => {
    if (!canOperate) return;
    if (s3ConfigDirty) {
      warning('Unsaved S3 settings', 'Save your S3 credentials before archiving.');
      return;
    }
    setArchivingNow(true);
    setS3ActionStatus(null);
    try {
      const response = await fetch('/api/storage/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pruneAfterUpload: false }),
      });
      if (response.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        const msg = String(data.error || 'Off-site S3 archive failed.');
        setS3ActionStatus({ ok: false, text: msg });
        error('Archive failed', msg);
        return;
      }
      const compressed = Number(data.compressedCount) || 0;
      const archived = Number(data.archivedCount) || 0;
      const msg = `Compressed ${compressed} file(s) and archived ${archived} partition(s) to S3 (local copies retained).`;
      setS3ActionStatus({ ok: true, text: msg });
      success('Archive completed', msg);
    } catch (archiveErr) {
      const msg =
        archiveErr instanceof Error ? archiveErr.message : 'Off-site S3 archive failed.';
      setS3ActionStatus({ ok: false, text: msg });
      error('Archive error', msg);
    } finally {
      setArchivingNow(false);
    }
  };

  const handleFormSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canAdminSettings) return;
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

    const trimmedEndpoint = s3Draft.s3Endpoint.trim();
    if (trimmedEndpoint) {
      try {
        const parsed = new URL(
          /^https?:\/\//i.test(trimmedEndpoint)
            ? trimmedEndpoint
            : `https://${trimmedEndpoint}`
        );
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('Invalid protocol');
        }
      } catch {
        setActiveTab('storage');
        error('Invalid S3 Endpoint', 'S3 Endpoint must be a valid http(s) URL.');
        return;
      }
    }

    const trimmedWebhookUrl = alertingDraft.webhookUrl.trim();
    if (trimmedWebhookUrl) {
      try {
        const parsed = new URL(trimmedWebhookUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('Invalid protocol');
        }
      } catch {
        setActiveTab('security');
        error('Invalid Webhook URL', 'Webhook URL must be a valid http(s) URL.');
        return;
      }
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
    setS3Draft(savedS3Settings);
    setS3SecretAccessKey('');
    setClearS3SecretKey(false);
    setS3ActionStatus(null);
    setAlertingDraft(savedAlertingSettings);
    setWebhookSecret('');
    setClearWebhookSecret(false);
    setWebhookTestStatus(null);
    setPrometheusMetricsToken('');
    setClearPrometheusToken(false);
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

      {!canAdminSettings && (
        <div
          role="status"
          className="border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[12px] text-[var(--text-muted)]"
        >
          Read-only configuration ({currentRole}) — only owners can modify platform settings, credentials, or run credential diagnostics.
        </div>
      )}

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
                      disabled={!canAdminSettings}
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
                      disabled={!canAdminSettings}
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
                      disabled={!canAdminSettings}
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
                      disabled={!canAdminSettings}
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
                <SettingsGroup title="CSV files & compression">
                  <SettingsField label="Root path">
                    <Input
                      compact
                      value={storagePath || 'Unavailable'}
                      readOnly
                      className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text-muted)]"
                    />
                  </SettingsField>
                  <SettingsField label="VPS disk usage">
                    <div className="flex flex-col gap-1 border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5">
                      <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-[var(--text)]">
                        <span>
                          {diskUsage?.available
                            ? `${diskUsage.usedPct.toFixed(1)}% used`
                            : 'Statfs unavailable'}
                        </span>
                        {diskUsage?.available && (
                          <span className="text-[10.5px] text-[var(--text-muted)]">
                            {formatGiB(diskUsage.freeBytes ?? diskUsage.availableBytes ?? 0)} free /{' '}
                            {formatGiB(diskUsage.totalBytes)}
                          </span>
                        )}
                      </div>
                      {diskUsage?.available && (
                        <div className="h-1.5 w-full border border-[var(--border)] bg-[var(--bg-main)]">
                          <div
                            className={`h-full ${
                              Number(numericDrafts.diskPauseThresholdPct) > 0 &&
                              diskUsage.usedPct >=
                                Number(numericDrafts.diskPauseThresholdPct)
                                ? 'bg-[var(--danger)]'
                                : diskUsage.usedPct >= 80
                                  ? 'bg-[var(--warning)]'
                                  : 'bg-[var(--accent)]'
                            }`}
                            style={{
                              width: `${Math.min(100, Math.max(0, diskUsage.usedPct))}%`,
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </SettingsField>
                  <SettingsField label="File rotation">
                    <Input
                      compact
                      type="number"
                      min={SETTINGS_LIMITS.fileRotationMb.min}
                      max={SETTINGS_LIMITS.fileRotationMb.max}
                      suffix="MB"
                      disabled={!canAdminSettings}
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
                      disabled={!canAdminSettings}
                      value={numericDrafts.autoPruneDays}
                      error={fieldErrors.autoPruneDays}
                      onChange={(event) =>
                        updateNumberDraft('autoPruneDays', event.target.value)
                      }
                      className="font-mono"
                    />
                  </SettingsField>
                  <SettingsField label="Auto-compress (.csv → .csv.gz)">
                    <Input
                      compact
                      type="number"
                      min={SETTINGS_LIMITS.compressAfterDays.min}
                      max={SETTINGS_LIMITS.compressAfterDays.max}
                      suffix="days"
                      disabled={!canAdminSettings}
                      value={numericDrafts.compressAfterDays}
                      error={fieldErrors.compressAfterDays}
                      onChange={(event) =>
                        updateNumberDraft('compressAfterDays', event.target.value)
                      }
                      className="font-mono"
                    />
                  </SettingsField>
                  <SettingsField label="Disk pause threshold (0 or 50–99%)">
                    <Input
                      compact
                      type="number"
                      min={SETTINGS_LIMITS.diskPauseThresholdPct.min}
                      max={SETTINGS_LIMITS.diskPauseThresholdPct.max}
                      suffix="%"
                      disabled={!canAdminSettings}
                      value={numericDrafts.diskPauseThresholdPct}
                      error={fieldErrors.diskPauseThresholdPct}
                      onChange={(event) =>
                        updateNumberDraft('diskPauseThresholdPct', event.target.value)
                      }
                      className="font-mono"
                    />
                  </SettingsField>
                </SettingsGroup>

                <SettingsGroup title="S3 / R2 off-site archive">
                  <SettingsField label="Automatic archive before prune">
                    <FormSwitch
                      label="Enable off-site S3 / R2 backup"
                      checked={s3Draft.enableS3Backup}
                      disabled={!canAdminSettings}
                      onChange={(checked) =>
                        setS3Draft((prev) => ({ ...prev, enableS3Backup: checked }))
                      }
                    />
                  </SettingsField>
                  <SettingsField label="S3 Endpoint URL">
                    <Input
                      compact
                      placeholder="https://<account>.r2.cloudflarestorage.com"
                      disabled={!canAdminSettings}
                      value={s3Draft.s3Endpoint}
                      onChange={(event) =>
                        setS3Draft((prev) => ({
                          ...prev,
                          s3Endpoint: event.target.value,
                        }))
                      }
                      className="font-mono text-[11px]"
                    />
                  </SettingsField>
                  <SettingsField label="Region">
                    <Input
                      compact
                      placeholder="auto"
                      disabled={!canAdminSettings}
                      value={s3Draft.s3Region}
                      onChange={(event) =>
                        setS3Draft((prev) => ({
                          ...prev,
                          s3Region: event.target.value,
                        }))
                      }
                      className="font-mono"
                    />
                  </SettingsField>
                  <SettingsField label="Bucket name">
                    <Input
                      compact
                      placeholder="my-datastack-archive"
                      disabled={!canAdminSettings}
                      value={s3Draft.s3Bucket}
                      onChange={(event) =>
                        setS3Draft((prev) => ({
                          ...prev,
                          s3Bucket: event.target.value,
                        }))
                      }
                      className="font-mono"
                    />
                  </SettingsField>
                  <SettingsField label="Key prefix">
                    <Input
                      compact
                      placeholder="datastack/"
                      disabled={!canAdminSettings}
                      value={s3Draft.s3Prefix}
                      onChange={(event) =>
                        setS3Draft((prev) => ({
                          ...prev,
                          s3Prefix: event.target.value,
                        }))
                      }
                      className="font-mono"
                    />
                  </SettingsField>
                  <SettingsField label="Access Key ID">
                    <Input
                      compact
                      placeholder="AKIA... / R2 Access Key ID"
                      disabled={!canAdminSettings}
                      value={s3Draft.s3AccessKeyId}
                      onChange={(event) =>
                        setS3Draft((prev) => ({
                          ...prev,
                          s3AccessKeyId: event.target.value,
                        }))
                      }
                      className="font-mono text-[11px]"
                    />
                  </SettingsField>
                  <SettingsField label="Secret Access Key (write-only)">
                    <div className="flex items-center gap-1.5">
                      <Input
                        compact
                        type="password"
                        autoComplete="new-password"
                        disabled={!canAdminSettings}
                        value={s3SecretAccessKey}
                        onChange={(event) => {
                          setS3SecretAccessKey(event.target.value);
                          if (clearS3SecretKey) setClearS3SecretKey(false);
                        }}
                        placeholder={
                          clearS3SecretKey
                            ? 'Saved key will be cleared on Save'
                            : hasS3SecretKey
                              ? `Saved (${s3SecretKeyMask || 'encrypted'}) — blank keeps current`
                              : 'Enter Secret Access Key...'
                        }
                        className="font-mono text-[11px]"
                      />
                      {hasS3SecretKey && (
                        <Button
                          type="button"
                          size="xs"
                          variant={clearS3SecretKey ? 'danger' : 'ghost'}
                          disabled={!canAdminSettings}
                          onClick={() => {
                            setClearS3SecretKey((prev) => !prev);
                            setS3SecretAccessKey('');
                          }}
                        >
                          {clearS3SecretKey ? 'Undo clear' : 'Clear key'}
                        </Button>
                      )}
                    </div>
                  </SettingsField>
                  <SettingsField label="Archive diagnostics">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                          type="button"
                          size="xs"
                          variant="secondary"
                          icon="Plug"
                          loading={testingS3}
                          disabled={!canAdminSettings || testingS3 || archivingNow}
                          onClick={() => void handleTestS3Connection()}
                        >
                          Test S3 Connection
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="secondary"
                          icon="UploadCloud"
                          loading={archivingNow}
                          disabled={!canOperate || testingS3 || archivingNow || s3ConfigDirty}
                          onClick={() => void handleArchiveNow()}
                        >
                          Archive Now
                        </Button>
                      </div>
                      {s3ConfigDirty && (
                        <span className="text-[10.5px] text-[var(--text-faint)]">
                          Save S3 changes before running Archive Now.
                        </span>
                      )}
                      {s3ActionStatus && (
                        <div
                          role="status"
                          className={`border px-2 py-1 text-[11px] ${
                            s3ActionStatus.ok
                              ? 'border-[var(--accent)] bg-[var(--surface-2)] text-[var(--text)]'
                              : 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]'
                          }`}
                        >
                          {s3ActionStatus.text}
                        </div>
                      )}
                    </div>
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
              <>
                <SettingsGroup title="Authentication">
                  <SettingsField label="JWT secret (min 32 chars)">
                    <Input
                      compact
                      type="password"
                      autoComplete="new-password"
                      disabled={!canAdminSettings}
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
                      disabled={!canAdminSettings}
                      value={numericDrafts.maxPayloadSizeKb}
                      error={fieldErrors.maxPayloadSizeKb}
                      onChange={(event) =>
                        updateNumberDraft('maxPayloadSizeKb', event.target.value)
                      }
                      className="font-mono"
                    />
                  </SettingsField>
                </SettingsGroup>

                <SettingsGroup title="Outbound webhook alerts">
                  <SettingsField label="Alert notifications">
                    <FormSwitch
                      label="Enable webhook alerts (Slack / Discord / JSON)"
                      checked={alertingDraft.enableWebhookAlerts}
                      disabled={!canAdminSettings}
                      onChange={(checked) =>
                        setAlertingDraft((prev) => ({
                          ...prev,
                          enableWebhookAlerts: checked,
                        }))
                      }
                    />
                  </SettingsField>
                  <SettingsField label="Webhook URL">
                    <Input
                      compact
                      placeholder="https://hooks.slack.com/services/..."
                      disabled={!canAdminSettings}
                      value={alertingDraft.webhookUrl}
                      onChange={(event) =>
                        setAlertingDraft((prev) => ({
                          ...prev,
                          webhookUrl: event.target.value,
                        }))
                      }
                      className="font-mono text-[11px]"
                    />
                  </SettingsField>
                  <SettingsField label="Webhook HMAC secret (write-only)">
                    <div className="flex items-center gap-1.5">
                      <Input
                        compact
                        type="password"
                        autoComplete="new-password"
                        disabled={!canAdminSettings}
                        value={webhookSecret}
                        onChange={(event) => {
                          setWebhookSecret(event.target.value);
                          if (clearWebhookSecret) setClearWebhookSecret(false);
                        }}
                        placeholder={
                          clearWebhookSecret
                            ? 'Saved secret will be cleared on Save'
                            : hasWebhookSecret
                              ? `Saved (${webhookSecretMask || 'encrypted'}) — blank keeps current`
                              : 'Optional HMAC-SHA256 signing secret...'
                        }
                        className="font-mono text-[11px]"
                      />
                      {hasWebhookSecret && (
                        <Button
                          type="button"
                          size="xs"
                          variant={clearWebhookSecret ? 'danger' : 'ghost'}
                          disabled={!canAdminSettings}
                          onClick={() => {
                            setClearWebhookSecret((prev) => !prev);
                            setWebhookSecret('');
                          }}
                        >
                          {clearWebhookSecret ? 'Undo clear' : 'Clear secret'}
                        </Button>
                      )}
                    </div>
                  </SettingsField>
                  <SettingsField label="Alert cooldown">
                    <Input
                      compact
                      type="number"
                      min={SETTINGS_LIMITS.webhookCooldownSec.min}
                      max={SETTINGS_LIMITS.webhookCooldownSec.max}
                      suffix="sec"
                      disabled={!canAdminSettings}
                      value={numericDrafts.webhookCooldownSec}
                      error={fieldErrors.webhookCooldownSec}
                      onChange={(event) =>
                        updateNumberDraft('webhookCooldownSec', event.target.value)
                      }
                      className="font-mono"
                    />
                  </SettingsField>
                  <SettingsField label="Webhook diagnostics">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                          type="button"
                          size="xs"
                          variant="secondary"
                          icon="Bell"
                          loading={testingWebhook}
                          disabled={!canAdminSettings || testingWebhook}
                          onClick={() => void handleTestWebhookAlert()}
                        >
                          Send Test Alert
                        </Button>
                      </div>
                      {webhookTestStatus && (
                        <div
                          role="status"
                          className={`border px-2 py-1 text-[11px] ${
                            webhookTestStatus.ok
                              ? 'border-[var(--accent)] bg-[var(--surface-2)] text-[var(--text)]'
                              : 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]'
                          }`}
                        >
                          {webhookTestStatus.text}
                        </div>
                      )}
                    </div>
                  </SettingsField>
                </SettingsGroup>

                <SettingsGroup title="Prometheus metrics (/api/prometheus)">
                  <SettingsField label="Scrape endpoint">
                    <FormSwitch
                      label="Enable /api/prometheus scrape endpoint"
                      checked={alertingDraft.enablePrometheusMetrics}
                      disabled={!canAdminSettings}
                      onChange={(checked) =>
                        setAlertingDraft((prev) => ({
                          ...prev,
                          enablePrometheusMetrics: checked,
                        }))
                      }
                    />
                  </SettingsField>
                  <SettingsField label="Scrape URL">
                    <Input
                      compact
                      value={baseUrl ? `${baseUrl}/api/prometheus` : '/api/prometheus'}
                      readOnly
                      className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text-muted)]"
                    />
                  </SettingsField>
                  <SettingsField label="Bearer scrape token (write-only)">
                    <div className="flex items-center gap-1.5">
                      <Input
                        compact
                        type="password"
                        autoComplete="new-password"
                        disabled={!canAdminSettings}
                        value={prometheusMetricsToken}
                        onChange={(event) => {
                          setPrometheusMetricsToken(event.target.value);
                          if (clearPrometheusToken) setClearPrometheusToken(false);
                        }}
                        placeholder={
                          clearPrometheusToken
                            ? 'Saved token will be cleared on Save'
                            : hasPrometheusToken
                              ? `Saved (${prometheusTokenMask || 'encrypted'}) — blank keeps current`
                              : 'Enter Bearer token for external Prometheus scrape...'
                        }
                        className="font-mono text-[11px]"
                      />
                      {hasPrometheusToken && (
                        <Button
                          type="button"
                          size="xs"
                          variant={clearPrometheusToken ? 'danger' : 'ghost'}
                          disabled={!canAdminSettings}
                          onClick={() => {
                            setClearPrometheusToken((prev) => !prev);
                            setPrometheusMetricsToken('');
                          }}
                        >
                          {clearPrometheusToken ? 'Undo clear' : 'Clear token'}
                        </Button>
                      )}
                    </div>
                  </SettingsField>
                </SettingsGroup>
              </>
            )}

            <SettingsFooter
              status={
                <>
                  <span
                    className={`h-1.5 w-1.5 ${
                      !canAdminSettings
                        ? 'bg-[var(--text-faint)]'
                        : isDirty
                          ? 'bg-[var(--warning)]'
                          : 'bg-[var(--accent)]'
                    }`}
                  />
                  <span>
                    {loading
                      ? 'Loading'
                      : !canAdminSettings
                        ? `Read-only (${currentRole})`
                        : isDirty
                          ? 'Unsaved changes'
                          : 'Saved'}
                  </span>
                </>
              }
            >
              <Button
                type="button"
                size="xs"
                disabled={!canAdminSettings || !isDirty || saving}
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
                disabled={!canAdminSettings || loading || !isDirty}
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
