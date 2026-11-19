export interface EditableSettings {
  maxEventsPerSec: number;
  maxPayloadSizeKb: number;
  batchFlushThreshold: number;
  batchFlushIntervalMs: number;
  fileRotationMb: number;
  enableIdempotency: boolean;
  autoPruneDays: number;
  compressAfterDays: number;
  diskPauseThresholdPct: number;
  webhookCooldownSec: number;
}

export interface S3SettingsFields {
  enableS3Backup: boolean;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3Prefix: string;
  s3AccessKeyId: string;
}

export interface AlertingAndMetricsSettingsFields {
  enableWebhookAlerts: boolean;
  webhookUrl: string;
  enablePrometheusMetrics: boolean;
}

export const DEFAULT_S3_SETTINGS: S3SettingsFields = {
  enableS3Backup: false,
  s3Endpoint: '',
  s3Region: 'auto',
  s3Bucket: '',
  s3Prefix: 'datastack/',
  s3AccessKeyId: '',
};

export const DEFAULT_ALERTING_SETTINGS: AlertingAndMetricsSettingsFields = {
  enableWebhookAlerts: false,
  webhookUrl: '',
  enablePrometheusMetrics: false,
};

export const SETTINGS_LIMITS = {
  maxEventsPerSec: { min: 1, max: 100000, defaultValue: 100 },
  maxPayloadSizeKb: { min: 1, max: 10240, defaultValue: 100 },
  batchFlushThreshold: { min: 1, max: 50000, defaultValue: 500 },
  batchFlushIntervalMs: { min: 100, max: 60000, defaultValue: 2000 },
  fileRotationMb: { min: 1, max: 2048, defaultValue: 100 },
  autoPruneDays: { min: 0, max: 3650, defaultValue: 30 },
  compressAfterDays: { min: 0, max: 3650, defaultValue: 0 },
  diskPauseThresholdPct: { min: 0, max: 99, defaultValue: 95 },
  webhookCooldownSec: { min: 10, max: 86400, defaultValue: 300 },
} as const;

export const DEFAULT_EDITABLE_SETTINGS: EditableSettings = {
  maxEventsPerSec: SETTINGS_LIMITS.maxEventsPerSec.defaultValue,
  maxPayloadSizeKb: SETTINGS_LIMITS.maxPayloadSizeKb.defaultValue,
  batchFlushThreshold: SETTINGS_LIMITS.batchFlushThreshold.defaultValue,
  batchFlushIntervalMs: SETTINGS_LIMITS.batchFlushIntervalMs.defaultValue,
  fileRotationMb: SETTINGS_LIMITS.fileRotationMb.defaultValue,
  enableIdempotency: true,
  autoPruneDays: SETTINGS_LIMITS.autoPruneDays.defaultValue,
  compressAfterDays: SETTINGS_LIMITS.compressAfterDays.defaultValue,
  diskPauseThresholdPct: SETTINGS_LIMITS.diskPauseThresholdPct.defaultValue,
  webhookCooldownSec: SETTINGS_LIMITS.webhookCooldownSec.defaultValue,
};

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(numeric)) return fallback;
  const rounded = Math.trunc(numeric);
  return Math.max(min, Math.min(max, rounded));
}

function normalizeDiskPauseThresholdPct(raw: unknown): number {
  const clamped = clampInt(
    raw,
    SETTINGS_LIMITS.diskPauseThresholdPct.min,
    SETTINGS_LIMITS.diskPauseThresholdPct.max,
    SETTINGS_LIMITS.diskPauseThresholdPct.defaultValue,
  );
  if (clamped !== 0 && clamped < 50) {
    return 50;
  }
  return clamped;
}

export function normalizeS3Settings(
  input: Partial<S3SettingsFields> | null | undefined,
): S3SettingsFields {
  return {
    enableS3Backup:
      typeof input?.enableS3Backup === 'boolean'
        ? input.enableS3Backup
        : DEFAULT_S3_SETTINGS.enableS3Backup,
    s3Endpoint: typeof input?.s3Endpoint === 'string' ? input.s3Endpoint.trim() : '',
    s3Region:
      typeof input?.s3Region === 'string' && input.s3Region.trim()
        ? input.s3Region.trim()
        : DEFAULT_S3_SETTINGS.s3Region,
    s3Bucket: typeof input?.s3Bucket === 'string' ? input.s3Bucket.trim() : '',
    s3Prefix:
      typeof input?.s3Prefix === 'string' ? input.s3Prefix.trim() : DEFAULT_S3_SETTINGS.s3Prefix,
    s3AccessKeyId:
      typeof input?.s3AccessKeyId === 'string' ? input.s3AccessKeyId.trim() : '',
  };
}

export function normalizeAlertingSettings(
  input: Partial<AlertingAndMetricsSettingsFields> | null | undefined,
): AlertingAndMetricsSettingsFields {
  return {
    enableWebhookAlerts:
      typeof input?.enableWebhookAlerts === 'boolean'
        ? input.enableWebhookAlerts
        : DEFAULT_ALERTING_SETTINGS.enableWebhookAlerts,
    webhookUrl:
      typeof input?.webhookUrl === 'string' ? input.webhookUrl.trim() : '',
    enablePrometheusMetrics:
      typeof input?.enablePrometheusMetrics === 'boolean'
        ? input.enablePrometheusMetrics
        : DEFAULT_ALERTING_SETTINGS.enablePrometheusMetrics,
  };
}

export function normalizeEditableSettings(
  input: Partial<EditableSettings>,
): EditableSettings {
  return {
    maxEventsPerSec: clampInt(
      input.maxEventsPerSec,
      SETTINGS_LIMITS.maxEventsPerSec.min,
      SETTINGS_LIMITS.maxEventsPerSec.max,
      SETTINGS_LIMITS.maxEventsPerSec.defaultValue,
    ),
    maxPayloadSizeKb: clampInt(
      input.maxPayloadSizeKb,
      SETTINGS_LIMITS.maxPayloadSizeKb.min,
      SETTINGS_LIMITS.maxPayloadSizeKb.max,
      SETTINGS_LIMITS.maxPayloadSizeKb.defaultValue,
    ),
    batchFlushThreshold: clampInt(
      input.batchFlushThreshold,
      SETTINGS_LIMITS.batchFlushThreshold.min,
      SETTINGS_LIMITS.batchFlushThreshold.max,
      SETTINGS_LIMITS.batchFlushThreshold.defaultValue,
    ),
    batchFlushIntervalMs: clampInt(
      input.batchFlushIntervalMs,
      SETTINGS_LIMITS.batchFlushIntervalMs.min,
      SETTINGS_LIMITS.batchFlushIntervalMs.max,
      SETTINGS_LIMITS.batchFlushIntervalMs.defaultValue,
    ),
    fileRotationMb: clampInt(
      input.fileRotationMb,
      SETTINGS_LIMITS.fileRotationMb.min,
      SETTINGS_LIMITS.fileRotationMb.max,
      SETTINGS_LIMITS.fileRotationMb.defaultValue,
    ),
    enableIdempotency:
      typeof input.enableIdempotency === 'boolean'
        ? input.enableIdempotency
        : DEFAULT_EDITABLE_SETTINGS.enableIdempotency,
    autoPruneDays: clampInt(
      input.autoPruneDays,
      SETTINGS_LIMITS.autoPruneDays.min,
      SETTINGS_LIMITS.autoPruneDays.max,
      SETTINGS_LIMITS.autoPruneDays.defaultValue,
    ),
    compressAfterDays: clampInt(
      input.compressAfterDays,
      SETTINGS_LIMITS.compressAfterDays.min,
      SETTINGS_LIMITS.compressAfterDays.max,
      SETTINGS_LIMITS.compressAfterDays.defaultValue,
    ),
    diskPauseThresholdPct: normalizeDiskPauseThresholdPct(
      input.diskPauseThresholdPct,
    ),
    webhookCooldownSec: clampInt(
      input.webhookCooldownSec,
      SETTINGS_LIMITS.webhookCooldownSec.min,
      SETTINGS_LIMITS.webhookCooldownSec.max,
      SETTINGS_LIMITS.webhookCooldownSec.defaultValue,
    ),
  };
}

export interface BridgeSyncPayload {
  attempted?: boolean;
  ok?: boolean;
  synced?: boolean;
  status?: number;
  error?: string;
  checkedAt?: string;
}

export function describeSettingsBridgeSync(
  bridgeSync: BridgeSyncPayload | undefined,
): { level: 'success' | 'warning' | 'error'; title: string; message?: string } {
  if (!bridgeSync) {
    return { level: 'success', title: 'Settings saved' };
  }
  const attempted =
    bridgeSync.attempted !== undefined
      ? bridgeSync.attempted
      : typeof bridgeSync.synced === 'boolean';
  const ok =
    bridgeSync.ok !== undefined
      ? bridgeSync.ok
      : Boolean(bridgeSync.synced);
  if (!attempted || ok) {
    return { level: 'success', title: 'Settings saved' };
  }
  if (bridgeSync.status === 401 || bridgeSync.status === 503) {
    return {
      level: 'error',
      title: 'Saved to DB — Ingestion bridge rejected sync',
      message:
        bridgeSync.error ||
        `Port 4000 returned HTTP ${bridgeSync.status}. Verify DATASTACK_INTERNAL_SECRET matches across runtimes.`,
    };
  }
  return {
    level: 'warning',
    title: 'Saved to DB — Ingestion bridge unreachable',
    message:
      bridgeSync.error ||
      'Port 4000 ingestion server is offline; changes will apply once it reconnects.',
  };
}

export type IngestionBridgeStatus = 'online' | 'auth_error' | 'error' | 'offline';
export type SocketHealthUiState =
  | 'idle'
  | 'checking'
  | 'online'
  | 'auth_error'
  | 'offline';

export function mapBridgeStatusToSocketUiState(
  status?: string,
): SocketHealthUiState {
  if (status === 'online') return 'online';
  if (status === 'auth_error') return 'auth_error';
  return 'offline';
}

export function parseEventTimestamp(value: string): Date | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) {
      const ms = asNumber < 1e11 ? asNumber * 1000 : asNumber;
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getEventUtcDate(value: string): string | null {
  const parsed = parseEventTimestamp(value);
  return parsed ? parsed.toISOString().slice(0, 10) : null;
}

export function formatEventTimeLabel(
  value: string,
  options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  },
): string {
  const parsed = parseEventTimestamp(value);
  return parsed ? parsed.toLocaleTimeString([], options) : value || '—';
}

export function getUtcDateRangeForPreset(
  preset: 'today' | '7d' | '30d' | 'all',
  referenceNow: Date = new Date(),
): { from: string; to: string } {
  if (preset === 'all') {
    return { from: '', to: '' };
  }
  const toUtc = new Date(
    Date.UTC(
      referenceNow.getUTCFullYear(),
      referenceNow.getUTCMonth(),
      referenceNow.getUTCDate(),
    ),
  );
  const offsetDays = preset === '7d' ? 6 : preset === '30d' ? 29 : 0;
  const fromUtc = new Date(toUtc.getTime() - offsetDays * 86_400_000);
  return {
    from: fromUtc.toISOString().slice(0, 10),
    to: toUtc.toISOString().slice(0, 10),
  };
}

export function sanitizeUiClientId(clientId: string): string {
  return clientId.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function matchesSelectedClientFolder(
  folderClientId: string,
  selectedClientId: string,
): boolean {
  if (!selectedClientId || selectedClientId === 'all') return true;
  const trimmed = selectedClientId.trim();
  return (
    folderClientId === trimmed ||
    folderClientId === sanitizeUiClientId(trimmed)
  );
}

export interface BufferedBucket {
  clientId: string;
  date: string;
  count: number;
}

export interface BufferedSummary {
  total: number;
  totalQueued: number;
  unattributedCount: number;
  truncated: boolean;
  buckets: BufferedBucket[];
}

export interface FilteredBufferedMatch {
  matchingCount: number;
  unattributedCount: number;
  totalQueued: number;
  hasPotentialBuffered: boolean;
}

export function countMatchingBufferedEvents(
  summary: BufferedSummary | null | undefined,
  filter: { clientId?: string; fromDate?: string; toDate?: string } = {},
  fallbackGlobalBufferCount = 0,
): FilteredBufferedMatch {
  if (!summary) {
    const safeFallback = Math.max(0, Number(fallbackGlobalBufferCount) || 0);
    return {
      matchingCount: 0,
      unattributedCount: safeFallback,
      totalQueued: safeFallback,
      hasPotentialBuffered: safeFallback > 0,
    };
  }

  const selectedClient = filter.clientId || 'all';
  const fromDate = filter.fromDate || '';
  const toDate = filter.toDate || '';
  const buckets = Array.isArray(summary.buckets) ? summary.buckets : [];

  let matchingCount = 0;
  for (const bucket of buckets) {
    if (!bucket || typeof bucket.count !== 'number' || bucket.count <= 0) continue;
    if (!matchesSelectedClientFolder(bucket.clientId, selectedClient)) continue;
    if (fromDate && bucket.date < fromDate) continue;
    if (toDate && bucket.date > toDate) continue;
    matchingCount += bucket.count;
  }

  const unattributedCount = Math.max(0, Number(summary.unattributedCount) || 0);
  const totalQueued = Math.max(
    matchingCount + unattributedCount,
    Number(summary.totalQueued) || 0,
  );

  return {
    matchingCount,
    unattributedCount,
    totalQueued,
    hasPotentialBuffered: matchingCount > 0 || unattributedCount > 0,
  };
}

export interface HttpBatchSummary {
  accepted: number;
  rejected: number;
  duplicates: number;
  status: 'Accepted' | 'Rejected';
  level: 'success' | 'warning' | 'error';
  title: string;
  message: string;
}

export function summarizeHttpBatchResult(
  resOk: boolean,
  data: Record<string, unknown> | null | undefined,
  sentCount: number,
): HttpBatchSummary {
  const safeSent = Math.max(0, Math.trunc(sentCount));
  const rawAccepted =
    typeof data?.accepted === 'number' && Number.isFinite(data.accepted)
      ? Math.max(0, Math.trunc(data.accepted))
      : typeof data?.processed === 'number' && Number.isFinite(data.processed)
        ? Math.max(0, Math.trunc(data.processed))
        : null;
  const rawDuplicates =
    typeof data?.duplicates === 'number' && Number.isFinite(data.duplicates)
      ? Math.max(0, Math.trunc(data.duplicates))
      : 0;
  const rawRejected =
    typeof data?.rejected === 'number' && Number.isFinite(data.rejected)
      ? Math.max(0, Math.trunc(data.rejected))
      : null;

  const serverError =
    typeof data?.error === 'string' && data.error.trim() ? data.error.trim() : '';

  if (rawAccepted === null) {
    return {
      accepted: 0,
      rejected: rawRejected ?? safeSent,
      duplicates: rawDuplicates,
      status: 'Rejected',
      level: 'error',
      title: 'Batch Rejected',
      message:
        serverError ||
        `Server response did not confirm batch ingestion (0/${safeSent} ingested).`,
    };
  }

  const accepted = rawAccepted;
  const duplicates = rawDuplicates;
  const rejected =
    rawRejected !== null
      ? rawRejected
      : Math.max(0, safeSent - accepted - duplicates);

  if (!resOk || (accepted === 0 && duplicates === 0)) {
    return {
      accepted,
      rejected,
      duplicates,
      status: 'Rejected',
      level: 'error',
      title: 'Batch Rejected',
      message: serverError || `${accepted}/${safeSent} ingested`,
    };
  }

  if (rejected > 0 || accepted + duplicates < safeSent) {
    const detail =
      duplicates > 0
        ? `${accepted}/${safeSent} ingested (${rejected} rejected, ${duplicates} duplicate)`
        : `${accepted}/${safeSent} ingested (${rejected} rejected)`;
    return {
      accepted,
      rejected,
      duplicates,
      status: 'Rejected',
      level: 'warning',
      title: 'Batch Partial',
      message: detail,
    };
  }

  const message =
    duplicates > 0
      ? `${accepted}/${safeSent} ingested (${duplicates} duplicate skipped)`
      : `${accepted}/${safeSent} ingested`;

  return {
    accepted,
    rejected,
    duplicates,
    status: 'Accepted',
    level: 'success',
    title: 'Batch Streamed',
    message,
  };
}

export function extractContentDispositionFilename(
  headerValue: string | null,
  fallback: string,
): string {
  if (!headerValue) return fallback;
  const quoted = headerValue.match(/filename="([^"]+)"/i);
  if (quoted && quoted[1]) return quoted[1];
  const bare = headerValue.match(/filename=([^;]+)/i);
  if (bare && bare[1]) return bare[1].trim();
  return fallback;
}

export type NumericSettingKey = keyof typeof SETTINGS_LIMITS;
export type NumericSettingDrafts = Record<NumericSettingKey, string>;
export type SettingsValidationErrors = Partial<Record<NumericSettingKey, string>>;

export const NUMERIC_SETTING_KEYS: readonly NumericSettingKey[] = [
  'maxEventsPerSec',
  'maxPayloadSizeKb',
  'batchFlushThreshold',
  'batchFlushIntervalMs',
  'fileRotationMb',
  'autoPruneDays',
  'compressAfterDays',
  'diskPauseThresholdPct',
  'webhookCooldownSec',
] as const;

export function settingsToNumericDrafts(
  settings: EditableSettings,
): NumericSettingDrafts {
  return {
    maxEventsPerSec: String(settings.maxEventsPerSec),
    maxPayloadSizeKb: String(settings.maxPayloadSizeKb),
    batchFlushThreshold: String(settings.batchFlushThreshold),
    batchFlushIntervalMs: String(settings.batchFlushIntervalMs),
    fileRotationMb: String(settings.fileRotationMb),
    autoPruneDays: String(settings.autoPruneDays),
    compressAfterDays: String(settings.compressAfterDays),
    diskPauseThresholdPct: String(settings.diskPauseThresholdPct),
    webhookCooldownSec: String(settings.webhookCooldownSec),
  };
}

export function validateSingleNumericSetting(
  key: NumericSettingKey,
  rawValue: string,
): { valid: true; value: number } | { valid: false; error: string } {
  const trimmed = String(rawValue ?? '').trim();
  const { min, max } = SETTINGS_LIMITS[key];
  if (!trimmed) {
    return { valid: false, error: 'Value is required.' };
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return { valid: false, error: 'Enter a whole number.' };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    return { valid: false, error: 'Enter a valid integer.' };
  }
  if (key === 'diskPauseThresholdPct') {
    if (parsed !== 0 && (parsed < 50 || parsed > max)) {
      return {
        valid: false,
        error: 'Must be 0 (disabled) or between 50 and 99.',
      };
    }
    return { valid: true, value: parsed };
  }
  if (parsed < min || parsed > max) {
    return {
      valid: false,
      error: `Must be between ${min.toLocaleString()} and ${max.toLocaleString()}.`,
    };
  }
  return { valid: true, value: parsed };
}

export function validateEditableSettingsDraft(
  drafts: NumericSettingDrafts,
  enableIdempotency: boolean,
): {
  valid: boolean;
  values?: EditableSettings;
  errors: SettingsValidationErrors;
  firstInvalidKey?: NumericSettingKey;
} {
  const errors: SettingsValidationErrors = {};
  const parsedValues: Partial<Record<NumericSettingKey, number>> = {};
  let firstInvalidKey: NumericSettingKey | undefined;

  for (const key of NUMERIC_SETTING_KEYS) {
    const result = validateSingleNumericSetting(key, drafts[key]);
    if (!result.valid) {
      errors[key] = result.error;
      if (!firstInvalidKey) firstInvalidKey = key;
    } else {
      parsedValues[key] = result.value;
    }
  }

  if (firstInvalidKey) {
    return { valid: false, errors, firstInvalidKey };
  }

  return {
    valid: true,
    errors,
    values: {
      maxEventsPerSec: parsedValues.maxEventsPerSec!,
      maxPayloadSizeKb: parsedValues.maxPayloadSizeKb!,
      batchFlushThreshold: parsedValues.batchFlushThreshold!,
      batchFlushIntervalMs: parsedValues.batchFlushIntervalMs!,
      fileRotationMb: parsedValues.fileRotationMb!,
      autoPruneDays: parsedValues.autoPruneDays!,
      compressAfterDays: parsedValues.compressAfterDays!,
      diskPauseThresholdPct: parsedValues.diskPauseThresholdPct!,
      webhookCooldownSec: parsedValues.webhookCooldownSec!,
      enableIdempotency: Boolean(enableIdempotency),
    },
  };
}

export interface BrowserLocationLike {
  protocol: string;
  hostname: string;
  host: string;
  port: string;
  origin?: string;
}

export interface PublicEndpoints {
  apiUrl: string;
  serverUrl: string;
  webSocketUrl: string;
}

export function resolvePublicEndpoints(
  loc: BrowserLocationLike,
  serverPort: number,
): PublicEndpoints {
  const safePort =
    Number.isFinite(serverPort) && serverPort > 0 ? Math.trunc(serverPort) : 4000;
  const httpProtocol = loc.protocol === 'https:' ? 'https:' : 'http:';
  const wsProtocol = httpProtocol === 'https:' ? 'wss:' : 'ws:';
  const apiUrl = loc.origin || `${httpProtocol}//${loc.host}`;
  const isDirectNextDev = loc.port === '3000';
  const ingestionHost = isDirectNextDev
    ? `${loc.hostname}:${safePort}`
    : loc.host;

  return {
    apiUrl,
    serverUrl: `${httpProtocol}//${ingestionHost}`,
    webSocketUrl: `${wsProtocol}//${ingestionHost}`,
  };
}

export function shouldRedirectProfileUnauthorized(
  status: number,
  body: Record<string, unknown> | null | undefined,
): boolean {
  if (status !== 401) return false;
  return body?.code !== 'INVALID_PASSWORD';
}

export function formatSessionExpiryLabel(value: string): string {
  if (!value) return 'Active';
  const parsed = parseEventTimestamp(value);
  if (!parsed) return 'Active';
  return parsed.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
