import {
  dispatchWebhookAlertAsync,
  type WebhookAlertPayload,
  type WebhookRuntimeConfig,
} from "../alerts/webhookNotifier";
import { AuthService, resolveDefaultJwtSecret } from "../auth/jwt";
import { DataBufferEngine } from "../data/buffer";
import { DatabaseEngine } from "../Database/database";
import { SDKManager } from "../sdk/sdkManager";
import {
  decryptSecret,
  encryptSecret,
  getMaskedHintFromEncrypted,
} from "../Security/secretVault";
import {
  SecurityEngine,
  getInternalIngestionHeaders,
} from "../Security/security";
import { CSVStorageManager } from "../Storage/csvStorage";
import {
  buildS3ObjectKey,
  type S3ArchiveConfig,
  uploadFileToS3,
} from "../Storage/s3Archive";

export interface AdminSettings {
  serverPort: number;
  webPort: number;
  maxEventsPerSec: number;
  maxPayloadSizeKb: number;
  batchFlushThreshold: number;
  batchFlushIntervalMs: number;
  fileRotationMb: number;
  jwtSecret: string;
  enableIdempotency: boolean;
  autoPruneDays: number;
  compressAfterDays: number;
  enableS3Backup: boolean;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3Prefix: string;
  s3AccessKeyId: string;
  s3SecretAccessKeyEnc: string;
  diskPauseThresholdPct: number;
  enableWebhookAlerts: boolean;
  webhookUrl: string;
  webhookSecretEnc: string;
  webhookCooldownSec: number;
  enablePrometheusMetrics: boolean;
  prometheusMetricsTokenEnc: string;
  updatedAt: string;
}

export interface PublicAdminSettings
  extends Omit<
    AdminSettings,
    | "jwtSecret"
    | "s3SecretAccessKeyEnc"
    | "webhookSecretEnc"
    | "prometheusMetricsTokenEnc"
  > {
  hasS3SecretKey: boolean;
  s3SecretKeyMask: string;
  hasWebhookSecret: boolean;
  webhookSecretMask: string;
  hasPrometheusToken: boolean;
  prometheusTokenMask: string;
}

export type AdminSettingsUpdateInput = Partial<AdminSettings> & {
  s3SecretAccessKey?: string;
  clearS3SecretKey?: boolean;
  webhookSecret?: string;
  clearWebhookSecret?: boolean;
  prometheusMetricsToken?: string;
  clearPrometheusToken?: boolean;
};

export interface SettingsBridgeSyncStatus {
  attempted: boolean;
  ok: boolean;
  synced: boolean;
  status?: number;
  error?: string;
  checkedAt: string;
}

type SettingsGlobals = typeof globalThis & {
  __dataStackAdminSettings?: AdminSettings;
  __dataStackSettingsHydrated?: boolean;
  __dataStackLastSettingsBridgeSync?: SettingsBridgeSyncStatus;
  __dataStackLastPruneMeta?: { days: number; ranAtMs: number };
  __dataStackLastCompressMeta?: { days: number; ranAtMs: number };
  __dataStackMaintenanceTimer?: ReturnType<typeof setInterval>;
  __dataStackMaintenanceIntervalMs?: number;
  __dataStackMaintenanceRunning?: boolean;
  __dataStackArchivePruneInFlight?: boolean;
  __dataStackCompressInFlight?: boolean;
};

const PRUNE_COOLDOWN_MS = 60 * 60 * 1000;
const COMPRESS_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;
const globals = globalThis as SettingsGlobals;

function resolveMaintenanceIntervalMs(overrideMs?: number): number {
  if (
    typeof overrideMs === "number" &&
    Number.isFinite(overrideMs) &&
    overrideMs >= 20
  ) {
    return Math.floor(overrideMs);
  }
  const envVal = Number(process.env.DATASTACK_MAINTENANCE_INTERVAL_MS);
  if (Number.isFinite(envVal) && envVal >= 1000) {
    return Math.floor(envVal);
  }
  return DEFAULT_MAINTENANCE_INTERVAL_MS;
}

function getDefaultSettings(): AdminSettings {
  return {
    serverPort: Number(process.env.PORT_SOCKET) || 4000,
    webPort: Number(process.env.PORT) || 3000,
    maxEventsPerSec: 100,
    maxPayloadSizeKb: 100,
    batchFlushThreshold: 500,
    batchFlushIntervalMs: 2000,
    fileRotationMb: 100,
    jwtSecret: resolveDefaultJwtSecret(),
    enableIdempotency: true,
    autoPruneDays: 30,
    compressAfterDays: 0,
    enableS3Backup: false,
    s3Endpoint: "",
    s3Region: "auto",
    s3Bucket: "",
    s3Prefix: "datastack/",
    s3AccessKeyId: "",
    s3SecretAccessKeyEnc: "",
    diskPauseThresholdPct: 95,
    enableWebhookAlerts: false,
    webhookUrl: "",
    webhookSecretEnc: "",
    webhookCooldownSec: 300,
    enablePrometheusMetrics: false,
    prometheusMetricsTokenEnc: "",
    updatedAt: new Date().toISOString(),
  };
}

function getSettingsState(): AdminSettings {
  if (!globals.__dataStackAdminSettings) {
    globals.__dataStackAdminSettings = getDefaultSettings();
  }
  return globals.__dataStackAdminSettings;
}

function toPublicSettings(settings: AdminSettings): PublicAdminSettings {
  const s3SecretKeyMask = getMaskedHintFromEncrypted(
    settings.s3SecretAccessKeyEnc,
  );
  const webhookSecretMask = getMaskedHintFromEncrypted(
    settings.webhookSecretEnc,
  );
  const prometheusTokenMask = getMaskedHintFromEncrypted(
    settings.prometheusMetricsTokenEnc,
  );
  return {
    serverPort: settings.serverPort,
    webPort: settings.webPort,
    maxEventsPerSec: settings.maxEventsPerSec,
    maxPayloadSizeKb: settings.maxPayloadSizeKb,
    batchFlushThreshold: settings.batchFlushThreshold,
    batchFlushIntervalMs: settings.batchFlushIntervalMs,
    fileRotationMb: settings.fileRotationMb,
    enableIdempotency: settings.enableIdempotency,
    autoPruneDays: settings.autoPruneDays,
    compressAfterDays: settings.compressAfterDays,
    enableS3Backup: settings.enableS3Backup,
    s3Endpoint: settings.s3Endpoint,
    s3Region: settings.s3Region,
    s3Bucket: settings.s3Bucket,
    s3Prefix: settings.s3Prefix,
    s3AccessKeyId: settings.s3AccessKeyId,
    hasS3SecretKey: Boolean(settings.s3SecretAccessKeyEnc),
    s3SecretKeyMask,
    diskPauseThresholdPct: settings.diskPauseThresholdPct,
    enableWebhookAlerts: settings.enableWebhookAlerts,
    webhookUrl: settings.webhookUrl,
    hasWebhookSecret: Boolean(settings.webhookSecretEnc),
    webhookSecretMask,
    webhookCooldownSec: settings.webhookCooldownSec,
    enablePrometheusMetrics: settings.enablePrometheusMetrics,
    hasPrometheusToken: Boolean(settings.prometheusMetricsTokenEnc),
    prometheusTokenMask,
    updatedAt: settings.updatedAt,
  };
}

export class SettingsManager {
  public static triggerWebhookAlert(payload: WebhookAlertPayload): void {
    const current = getSettingsState();
    if (!current.enableWebhookAlerts || !current.webhookUrl.trim()) {
      return;
    }
    void (async () => {
      try {
        let secret = "";
        if (current.webhookSecretEnc) {
          try {
            secret = decryptSecret(current.webhookSecretEnc);
          } catch {
            secret = "";
          }
        }
        await dispatchWebhookAlertAsync(payload, {
          enabled: current.enableWebhookAlerts,
          webhookUrl: current.webhookUrl,
          webhookSecret: secret,
          cooldownSec: current.webhookCooldownSec,
        });
      } catch {
        // Never allow background webhook dispatch to throw into callers
      }
    })();
  }

  private static async executeArchiveAndPrune(
    settings: AdminSettings,
  ): Promise<void> {
    if (!settings.enableS3Backup) {
      await CSVStorageManager.pruneExpiredPartitionsAsync(
        settings.autoPruneDays,
      );
      return;
    }

    const s3Config: S3ArchiveConfig = {
      endpoint: settings.s3Endpoint,
      region: settings.s3Region,
      bucket: settings.s3Bucket,
      prefix: settings.s3Prefix,
      accessKeyId: settings.s3AccessKeyId,
      secretAccessKey: decryptSecret(settings.s3SecretAccessKeyEnc),
    };

    await CSVStorageManager.pruneOrArchiveExpiredPartitionsAsync(
      settings.autoPruneDays,
      {
        beforeDeleteFile: async (file) => {
          const objectKey = buildS3ObjectKey(
            s3Config.prefix,
            file.clientId,
            file.filename,
          );
          const result = await uploadFileToS3(
            s3Config,
            file.filePath,
            objectKey,
          );
          if (!result.ok) {
            const errMsg =
              result.error || `Failed to upload ${file.filename} to S3`;
            this.triggerWebhookAlert({
              event: "S3_ARCHIVE_FAILED",
              severity: "critical",
              title: "Off-Site S3 Archive Upload Failed",
              message: errMsg,
              clientId: file.clientId,
              details: { filename: file.filename, bucket: s3Config.bucket },
            });
            throw new Error(errMsg);
          }
        },
      },
    );
  }

  public static isMaintenanceSchedulerActive(): boolean {
    return Boolean(globals.__dataStackMaintenanceTimer);
  }

  public static ensureMaintenanceScheduler(intervalMs?: number): boolean {
    const effectiveIntervalMs = resolveMaintenanceIntervalMs(intervalMs);
    if (globals.__dataStackMaintenanceTimer) {
      if (
        intervalMs === undefined ||
        globals.__dataStackMaintenanceIntervalMs === effectiveIntervalMs
      ) {
        return false;
      }
      clearInterval(globals.__dataStackMaintenanceTimer);
      delete globals.__dataStackMaintenanceTimer;
    }

    const timer = setInterval(() => {
      void this.runScheduledMaintenanceTick().catch((err) => {
        console.warn(
          "[DataStack Storage] Periodic maintenance tick failed:",
          err,
        );
      });
    }, effectiveIntervalMs);
    timer.unref?.();
    globals.__dataStackMaintenanceTimer = timer;
    globals.__dataStackMaintenanceIntervalMs = effectiveIntervalMs;
    return true;
  }

  public static async bootstrapMaintenanceSchedulerOnBoot(): Promise<{
    schedulerActive: boolean;
    hydrated: boolean;
    error?: string;
  }> {
    this.ensureMaintenanceScheduler();
    try {
      await this.getSettingsAsync();
      return {
        schedulerActive: this.isMaintenanceSchedulerActive(),
        hydrated:
          !process.env.DATABASE_URL?.trim() ||
          globals.__dataStackSettingsHydrated === true,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        "[DataStack Boot] Maintenance scheduler init deferred/failed:",
        message,
      );
      return {
        schedulerActive: this.isMaintenanceSchedulerActive(),
        hydrated: false,
        error: message,
      };
    }
  }

  public static stopMaintenanceScheduler(): void {
    if (globals.__dataStackMaintenanceTimer) {
      clearInterval(globals.__dataStackMaintenanceTimer);
      delete globals.__dataStackMaintenanceTimer;
    }
    delete globals.__dataStackMaintenanceIntervalMs;
    globals.__dataStackMaintenanceRunning = false;
  }

  public static stopMaintenanceSchedulerForTests(): void {
    this.stopMaintenanceScheduler();
    globals.__dataStackArchivePruneInFlight = false;
    globals.__dataStackCompressInFlight = false;
  }

  public static async runScheduledMaintenanceTick(options?: {
    forceCompress?: boolean;
    forcePrune?: boolean;
    skipDbSync?: boolean;
  }): Promise<{
    ran: boolean;
    skippedReason?: string;
    compressed: boolean;
    archivedOrPruned: boolean;
  }> {
    if (globals.__dataStackMaintenanceRunning) {
      return {
        ran: false,
        skippedReason: "ALREADY_RUNNING",
        compressed: false,
        archivedOrPruned: false,
      };
    }

    globals.__dataStackMaintenanceRunning = true;
    try {
      const hasConfiguredDb = Boolean(process.env.DATABASE_URL?.trim());
      if (hasConfiguredDb && !options?.skipDbSync) {
        await this.syncFromDatabase(true);
      }

      const dbReadyForMaintenance =
        !hasConfiguredDb || globals.__dataStackSettingsHydrated === true;
      if (!dbReadyForMaintenance) {
        return {
          ran: false,
          skippedReason: "DB_UNHYDRATED",
          compressed: false,
          archivedOrPruned: false,
        };
      }

      const settings = getSettingsState();
      const now = Date.now();
      let compressed = false;
      let archivedOrPruned = false;

      if (
        settings.compressAfterDays > 0 &&
        !globals.__dataStackCompressInFlight
      ) {
        const prevComp = globals.__dataStackLastCompressMeta;
        const shouldCompress =
          Boolean(options?.forceCompress) ||
          !prevComp ||
          prevComp.days !== settings.compressAfterDays ||
          now - prevComp.ranAtMs >= COMPRESS_COOLDOWN_MS;
        if (shouldCompress) {
          globals.__dataStackLastCompressMeta = {
            days: settings.compressAfterDays,
            ranAtMs: now,
          };
          globals.__dataStackCompressInFlight = true;
          try {
            await CSVStorageManager.compressOldPartitionsAsync(
              settings.compressAfterDays,
            );
            compressed = true;
          } catch (err) {
            console.warn(
              "[DataStack Storage] Scheduled partition compression failed:",
              err,
            );
          } finally {
            globals.__dataStackCompressInFlight = false;
          }
        }
      }

      if (
        settings.autoPruneDays > 0 &&
        !globals.__dataStackArchivePruneInFlight
      ) {
        const prevPrune = globals.__dataStackLastPruneMeta;
        const shouldPrune =
          Boolean(options?.forcePrune) ||
          !prevPrune ||
          prevPrune.days !== settings.autoPruneDays ||
          now - prevPrune.ranAtMs >= PRUNE_COOLDOWN_MS;
        if (shouldPrune) {
          globals.__dataStackLastPruneMeta = {
            days: settings.autoPruneDays,
            ranAtMs: now,
          };
          globals.__dataStackArchivePruneInFlight = true;
          try {
            await this.executeArchiveAndPrune(settings);
            archivedOrPruned = true;
          } catch (err) {
            console.warn(
              "[DataStack Storage] Scheduled partition prune/archive failed:",
              err,
            );
          } finally {
            globals.__dataStackArchivePruneInFlight = false;
          }
        }
      }

      return { ran: true, compressed, archivedOrPruned };
    } finally {
      globals.__dataStackMaintenanceRunning = false;
    }
  }

  private static applyRuntimeSettings(
    settings: AdminSettings,
    forcePrune = false,
    forceCompress = false,
    skipBackgroundMaintenance = false,
  ) {
    SecurityEngine.maxEventsPerSec = settings.maxEventsPerSec;
    SecurityEngine.enableIdempotency = settings.enableIdempotency;
    SecurityEngine.maxPayloadSizeBytes = settings.maxPayloadSizeKb * 1024;
    DataBufferEngine.batchFlushThreshold = settings.batchFlushThreshold;
    DataBufferEngine.setFlushInterval(settings.batchFlushIntervalMs);
    if (settings.jwtSecret) {
      AuthService.setSecret(settings.jwtSecret);
    }
    CSVStorageManager.maxFileSizeBytes = settings.fileRotationMb * 1024 * 1024;
    this.ensureMaintenanceScheduler();
    if (skipBackgroundMaintenance) {
      return;
    }
    const hasConfiguredDb = Boolean(process.env.DATABASE_URL?.trim());
    const dbReadyForMaintenance =
      !hasConfiguredDb || globals.__dataStackSettingsHydrated === true;

    if (
      settings.compressAfterDays > 0 &&
      dbReadyForMaintenance &&
      !globals.__dataStackCompressInFlight
    ) {
      const prevComp = globals.__dataStackLastCompressMeta;
      const now = Date.now();
      const shouldCompress =
        forceCompress ||
        !prevComp ||
        prevComp.days !== settings.compressAfterDays ||
        now - prevComp.ranAtMs >= COMPRESS_COOLDOWN_MS;
      if (shouldCompress) {
        globals.__dataStackLastCompressMeta = {
          days: settings.compressAfterDays,
          ranAtMs: now,
        };
        globals.__dataStackCompressInFlight = true;
        void CSVStorageManager.compressOldPartitionsAsync(
          settings.compressAfterDays,
        )
          .catch((err) => {
            console.warn(
              "[DataStack Storage] Background partition compression failed:",
              err,
            );
          })
          .finally(() => {
            globals.__dataStackCompressInFlight = false;
          });
      }
    }

    if (
      settings.autoPruneDays > 0 &&
      dbReadyForMaintenance &&
      !globals.__dataStackArchivePruneInFlight
    ) {
      const prev = globals.__dataStackLastPruneMeta;
      const now = Date.now();
      const shouldPrune =
        forcePrune ||
        !prev ||
        prev.days !== settings.autoPruneDays ||
        now - prev.ranAtMs >= PRUNE_COOLDOWN_MS;
      if (shouldPrune) {
        globals.__dataStackLastPruneMeta = {
          days: settings.autoPruneDays,
          ranAtMs: now,
        };
        globals.__dataStackArchivePruneInFlight = true;
        void this.executeArchiveAndPrune(settings)
          .catch((err) => {
            console.warn(
              "[DataStack Storage] Background async partition prune/archive failed:",
              err,
            );
          })
          .finally(() => {
            globals.__dataStackArchivePruneInFlight = false;
          });
      }
    }
  }

  private static async syncFromDatabase(
    skipBackgroundMaintenance = false,
  ): Promise<AdminSettings | null> {
    const pool = DatabaseEngine.getPool();
    if (!pool) return null;

    try {
      const ready = await DatabaseEngine.ensureSchema();
      if (!ready) return null;

      const result = await pool.query(
        `SELECT server_port, web_port, max_events_per_sec, max_payload_size_kb,
                batch_flush_threshold, batch_flush_interval_ms, file_rotation_mb,
                jwt_secret, enable_idempotency, auto_prune_days,
                compress_after_days, enable_s3_backup, s3_endpoint, s3_region,
                s3_bucket, s3_prefix, s3_access_key_id, s3_secret_access_key_enc,
                disk_pause_threshold_pct, enable_webhook_alerts, webhook_url,
                webhook_secret_enc, webhook_cooldown_sec, enable_prometheus_metrics,
                prometheus_metrics_token_enc, updated_at
         FROM admin_settings
         WHERE id = 'default'`,
      );

      if (result.rowCount && result.rowCount > 0) {
        const row = result.rows[0];
        const parsedPruneDays =
          row.auto_prune_days !== undefined && row.auto_prune_days !== null
            ? Number(row.auto_prune_days)
            : NaN;
        const parsedCompressDays =
          row.compress_after_days !== undefined &&
          row.compress_after_days !== null
            ? Number(row.compress_after_days)
            : NaN;
        const parsedDiskThreshold =
          row.disk_pause_threshold_pct !== undefined &&
          row.disk_pause_threshold_pct !== null
            ? Number(row.disk_pause_threshold_pct)
            : NaN;
        const parsedWebhookCooldown =
          row.webhook_cooldown_sec !== undefined &&
          row.webhook_cooldown_sec !== null
            ? Number(row.webhook_cooldown_sec)
            : NaN;
        const envSocketPort = Number(process.env.PORT_SOCKET);
        const envWebPort = Number(process.env.PORT);
        const loaded: AdminSettings = {
          serverPort:
            Number.isFinite(envSocketPort) && envSocketPort > 0
              ? envSocketPort
              : Number(row.server_port) || 4000,
          webPort:
            Number.isFinite(envWebPort) && envWebPort > 0
              ? envWebPort
              : Number(row.web_port) || 3000,
          maxEventsPerSec: Number(row.max_events_per_sec) || 100,
          maxPayloadSizeKb: Number(row.max_payload_size_kb) || 100,
          batchFlushThreshold: Number(row.batch_flush_threshold) || 500,
          batchFlushIntervalMs: Number(row.batch_flush_interval_ms) || 2000,
          fileRotationMb: Number(row.file_rotation_mb) || 100,
          jwtSecret:
            String(row.jwt_secret || "").trim() || resolveDefaultJwtSecret(),
          enableIdempotency: Boolean(row.enable_idempotency),
          autoPruneDays: Number.isFinite(parsedPruneDays) ? parsedPruneDays : 30,
          compressAfterDays: Number.isFinite(parsedCompressDays)
            ? Math.max(0, parsedCompressDays)
            : 0,
          enableS3Backup: Boolean(row.enable_s3_backup),
          s3Endpoint: String(row.s3_endpoint ?? ""),
          s3Region: String(row.s3_region || "auto"),
          s3Bucket: String(row.s3_bucket ?? ""),
          s3Prefix: String(row.s3_prefix ?? "datastack/"),
          s3AccessKeyId: String(row.s3_access_key_id ?? ""),
          s3SecretAccessKeyEnc: String(row.s3_secret_access_key_enc ?? ""),
          diskPauseThresholdPct: Number.isFinite(parsedDiskThreshold)
            ? parsedDiskThreshold
            : 95,
          enableWebhookAlerts: Boolean(row.enable_webhook_alerts),
          webhookUrl: String(row.webhook_url ?? ""),
          webhookSecretEnc: String(row.webhook_secret_enc ?? ""),
          webhookCooldownSec:
            Number.isFinite(parsedWebhookCooldown) && parsedWebhookCooldown >= 10
              ? Math.floor(parsedWebhookCooldown)
              : 300,
          enablePrometheusMetrics: Boolean(row.enable_prometheus_metrics),
          prometheusMetricsTokenEnc: String(
            row.prometheus_metrics_token_enc ?? "",
          ),
          updatedAt: row.updated_at
            ? new Date(row.updated_at as string | Date).toISOString()
            : new Date().toISOString(),
        };
        globals.__dataStackAdminSettings = loaded;
        globals.__dataStackSettingsHydrated = true;
        this.applyRuntimeSettings(
          loaded,
          false,
          false,
          skipBackgroundMaintenance,
        );
        return loaded;
      }

      // Initialize default row in PostgreSQL if not present yet
      const defaults = getSettingsState();
      const hasValidProductionJwt =
        process.env.NODE_ENV !== "production" ||
        defaults.jwtSecret.trim().length >= 32;
      if (!hasValidProductionJwt) {
        return defaults;
      }
      await this.persistSettingsToDb(defaults);
      globals.__dataStackSettingsHydrated = true;
      return defaults;
    } catch {
      return null;
    }
  }

  private static async persistSettingsToDb(
    settings: AdminSettings,
  ): Promise<void> {
    const pool = DatabaseEngine.getPool();
    if (!pool) return;

    if (
      process.env.NODE_ENV === "production" &&
      settings.jwtSecret.trim().length < 32
    ) {
      throw new Error(
        "DATABASE_WRITE_FAILED: Cannot persist settings without a valid DATASTACK_JWT_SECRET (>= 32 characters) in production.",
      );
    }

    const ready = await DatabaseEngine.ensureSchema();
    if (!ready) {
      throw new Error(
        "DATABASE_WRITE_FAILED: PostgreSQL schema is unavailable while saving settings.",
      );
    }

    try {
      await pool.query(
        `INSERT INTO admin_settings (
           id, server_port, web_port, max_events_per_sec, max_payload_size_kb,
           batch_flush_threshold, batch_flush_interval_ms, file_rotation_mb,
           jwt_secret, enable_idempotency, auto_prune_days,
           compress_after_days, enable_s3_backup, s3_endpoint, s3_region,
           s3_bucket, s3_prefix, s3_access_key_id, s3_secret_access_key_enc,
           disk_pause_threshold_pct, enable_webhook_alerts, webhook_url,
           webhook_secret_enc, webhook_cooldown_sec, enable_prometheus_metrics,
           prometheus_metrics_token_enc, updated_at
         ) VALUES (
           'default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
           $22, $23, $24, $25, NOW()
         )
         ON CONFLICT (id) DO UPDATE SET
           server_port = EXCLUDED.server_port,
           web_port = EXCLUDED.web_port,
           max_events_per_sec = EXCLUDED.max_events_per_sec,
           max_payload_size_kb = EXCLUDED.max_payload_size_kb,
           batch_flush_threshold = EXCLUDED.batch_flush_threshold,
           batch_flush_interval_ms = EXCLUDED.batch_flush_interval_ms,
           file_rotation_mb = EXCLUDED.file_rotation_mb,
           jwt_secret = EXCLUDED.jwt_secret,
           enable_idempotency = EXCLUDED.enable_idempotency,
           auto_prune_days = EXCLUDED.auto_prune_days,
           compress_after_days = EXCLUDED.compress_after_days,
           enable_s3_backup = EXCLUDED.enable_s3_backup,
           s3_endpoint = EXCLUDED.s3_endpoint,
           s3_region = EXCLUDED.s3_region,
           s3_bucket = EXCLUDED.s3_bucket,
           s3_prefix = EXCLUDED.s3_prefix,
           s3_access_key_id = EXCLUDED.s3_access_key_id,
           s3_secret_access_key_enc = EXCLUDED.s3_secret_access_key_enc,
           disk_pause_threshold_pct = EXCLUDED.disk_pause_threshold_pct,
           enable_webhook_alerts = EXCLUDED.enable_webhook_alerts,
           webhook_url = EXCLUDED.webhook_url,
           webhook_secret_enc = EXCLUDED.webhook_secret_enc,
           webhook_cooldown_sec = EXCLUDED.webhook_cooldown_sec,
           enable_prometheus_metrics = EXCLUDED.enable_prometheus_metrics,
           prometheus_metrics_token_enc = EXCLUDED.prometheus_metrics_token_enc,
           updated_at = NOW()`,
        [
          settings.serverPort,
          settings.webPort,
          settings.maxEventsPerSec,
          settings.maxPayloadSizeKb,
          settings.batchFlushThreshold,
          settings.batchFlushIntervalMs,
          settings.fileRotationMb,
          settings.jwtSecret,
          settings.enableIdempotency,
          settings.autoPruneDays,
          settings.compressAfterDays,
          settings.enableS3Backup,
          settings.s3Endpoint,
          settings.s3Region,
          settings.s3Bucket,
          settings.s3Prefix,
          settings.s3AccessKeyId,
          settings.s3SecretAccessKeyEnc,
          settings.diskPauseThresholdPct,
          settings.enableWebhookAlerts,
          settings.webhookUrl,
          settings.webhookSecretEnc,
          settings.webhookCooldownSec,
          settings.enablePrometheusMetrics,
          settings.prometheusMetricsTokenEnc,
        ],
      );
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : "Unknown DB error";
      throw new Error(`DATABASE_WRITE_FAILED: Failed to persist settings (${detail})`);
    }
  }

  public static getSettings(): AdminSettings {
    if (!globals.__dataStackSettingsHydrated) {
      void this.syncFromDatabase();
    }
    const current = getSettingsState();
    this.applyRuntimeSettings(current);
    return { ...current };
  }

  public static async getSettingsAsync(): Promise<AdminSettings> {
    const fromDb = await this.syncFromDatabase();
    if (fromDb) {
      return { ...fromDb };
    }
    const current = getSettingsState();
    this.applyRuntimeSettings(current);
    return { ...current };
  }

  public static getPublicSettings(): PublicAdminSettings {
    return toPublicSettings(this.getSettings());
  }

  public static async getPublicSettingsAsync(): Promise<PublicAdminSettings> {
    const settings = await this.getSettingsAsync();
    return toPublicSettings(settings);
  }

  public static async getDecryptedS3ConfigAsync(): Promise<S3ArchiveConfig> {
    const settings = await this.getSettingsAsync();
    return {
      endpoint: settings.s3Endpoint,
      region: settings.s3Region,
      bucket: settings.s3Bucket,
      prefix: settings.s3Prefix,
      accessKeyId: settings.s3AccessKeyId,
      secretAccessKey: decryptSecret(settings.s3SecretAccessKeyEnc),
    };
  }

  public static async getDecryptedWebhookConfigAsync(): Promise<WebhookRuntimeConfig> {
    const settings = await this.getSettingsAsync();
    return {
      enabled: settings.enableWebhookAlerts,
      webhookUrl: settings.webhookUrl,
      webhookSecret: settings.webhookSecretEnc
        ? decryptSecret(settings.webhookSecretEnc)
        : "",
      cooldownSec: settings.webhookCooldownSec,
    };
  }

  public static async getDecryptedPrometheusConfigAsync(): Promise<{
    enabled: boolean;
    token: string;
  }> {
    const settings = await this.getSettingsAsync();
    return {
      enabled: settings.enablePrometheusMetrics,
      token: settings.prometheusMetricsTokenEnc
        ? decryptSecret(settings.prometheusMetricsTokenEnc)
        : "",
    };
  }

  public static getLastBridgeSyncStatus(): SettingsBridgeSyncStatus | null {
    return globals.__dataStackLastSettingsBridgeSync ?? null;
  }

  private static async notifyIngestionSettingsSync(
    settings: AdminSettings,
    authJwtSecret: string,
    jwtSecretChanged: boolean,
  ): Promise<SettingsBridgeSyncStatus> {
    const checkedAt = new Date().toISOString();
    const headers = getInternalIngestionHeaders(authJwtSecret);
    if (!headers["x-datastack-internal-secret"]) {
      const result: SettingsBridgeSyncStatus = {
        attempted: true,
        ok: false,
        synced: false,
        error: "Internal bridge secret is not configured",
        checkedAt,
      };
      globals.__dataStackLastSettingsBridgeSync = result;
      return result;
    }

    const ingestionBaseUrl = (
      process.env.INGESTION_INTERNAL_URL || "http://127.0.0.1:4000"
    ).replace(/\/$/, "");

    let decryptedWebhookSecret = "";
    if (settings.webhookSecretEnc) {
      try {
        decryptedWebhookSecret = decryptSecret(settings.webhookSecretEnc);
      } catch (vaultErr: unknown) {
        console.warn(
          "[DataStack Bridge] Stored webhook secret could not be decrypted during Port 4000 settings sync; continuing with empty webhook secret:",
          vaultErr instanceof Error ? vaultErr.message : vaultErr,
        );
        decryptedWebhookSecret = "";
      }
    }

    try {
      const res = await fetch(`${ingestionBaseUrl}/internal/settings-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          maxEventsPerSec: settings.maxEventsPerSec,
          maxPayloadSizeKb: settings.maxPayloadSizeKb,
          batchFlushThreshold: settings.batchFlushThreshold,
          batchFlushIntervalMs: settings.batchFlushIntervalMs,
          fileRotationMb: settings.fileRotationMb,
          enableIdempotency: settings.enableIdempotency,
          autoPruneDays: settings.autoPruneDays,
          compressAfterDays: settings.compressAfterDays,
          enableS3Backup: settings.enableS3Backup,
          diskPauseThresholdPct: settings.diskPauseThresholdPct,
          enableWebhookAlerts: settings.enableWebhookAlerts,
          webhookUrl: settings.webhookUrl,
          webhookSecret: decryptedWebhookSecret,
          webhookCooldownSec: settings.webhookCooldownSec,
          ...(jwtSecretChanged ? { jwtSecret: settings.jwtSecret } : {}),
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) {
        const errorMsg = `Port 4000 settings-sync failed with HTTP ${res.status}`;
        console.warn(`[DataStack Bridge] ${errorMsg}`);
        const result: SettingsBridgeSyncStatus = {
          attempted: true,
          ok: false,
          synced: false,
          status: res.status,
          error: errorMsg,
          checkedAt,
        };
        globals.__dataStackLastSettingsBridgeSync = result;
        return result;
      }
      const result: SettingsBridgeSyncStatus = {
        attempted: true,
        ok: true,
        synced: true,
        status: res.status,
        checkedAt,
      };
      globals.__dataStackLastSettingsBridgeSync = result;
      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : "Port 4000 settings-sync unreachable";
      if (
        process.env.NODE_ENV === "production" ||
        Boolean(process.env.INGESTION_INTERNAL_URL)
      ) {
        console.warn(`[DataStack Bridge] ${message}`);
      }
      const result: SettingsBridgeSyncStatus = {
        attempted: true,
        ok: false,
        synced: false,
        error: message,
        checkedAt,
      };
      globals.__dataStackLastSettingsBridgeSync = result;
      return result;
    }
  }

  private static mergeSettingsUpdate(
    current: AdminSettings,
    updates: AdminSettingsUpdateInput,
  ): AdminSettings {
    const {
      s3SecretAccessKey,
      clearS3SecretKey,
      webhookSecret,
      clearWebhookSecret,
      prometheusMetricsToken,
      clearPrometheusToken,
      ...rest
    } = updates;
    let nextEncryptedSecret = current.s3SecretAccessKeyEnc;
    if (clearS3SecretKey) {
      nextEncryptedSecret = "";
    } else if (
      typeof s3SecretAccessKey === "string" &&
      s3SecretAccessKey.trim().length > 0
    ) {
      nextEncryptedSecret = encryptSecret(s3SecretAccessKey.trim());
    } else if (rest.s3SecretAccessKeyEnc !== undefined) {
      nextEncryptedSecret = rest.s3SecretAccessKeyEnc;
    }

    let nextWebhookSecretEnc = current.webhookSecretEnc;
    if (clearWebhookSecret) {
      nextWebhookSecretEnc = "";
    } else if (
      typeof webhookSecret === "string" &&
      webhookSecret.trim().length > 0
    ) {
      nextWebhookSecretEnc = encryptSecret(webhookSecret.trim());
    } else if (rest.webhookSecretEnc !== undefined) {
      nextWebhookSecretEnc = rest.webhookSecretEnc;
    }

    let nextPrometheusTokenEnc = current.prometheusMetricsTokenEnc;
    if (clearPrometheusToken) {
      nextPrometheusTokenEnc = "";
    } else if (
      typeof prometheusMetricsToken === "string" &&
      prometheusMetricsToken.trim().length > 0
    ) {
      nextPrometheusTokenEnc = encryptSecret(prometheusMetricsToken.trim());
    } else if (rest.prometheusMetricsTokenEnc !== undefined) {
      nextPrometheusTokenEnc = rest.prometheusMetricsTokenEnc;
    }

    return {
      ...current,
      ...rest,
      s3SecretAccessKeyEnc: nextEncryptedSecret,
      webhookSecretEnc: nextWebhookSecretEnc,
      prometheusMetricsTokenEnc: nextPrometheusTokenEnc,
      updatedAt: new Date().toISOString(),
    };
  }

  public static updateSettings(
    updates: AdminSettingsUpdateInput,
  ): AdminSettings {
    const current = getSettingsState();
    const previousJwtSecret = current.jwtSecret;
    const jwtSecretChanged =
      Boolean(updates.jwtSecret) && updates.jwtSecret !== current.jwtSecret;
    const nextSettings = this.mergeSettingsUpdate(current, updates);
    globals.__dataStackAdminSettings = nextSettings;
    this.applyRuntimeSettings(
      nextSettings,
      updates.autoPruneDays !== undefined,
      updates.compressAfterDays !== undefined,
    );
    if (jwtSecretChanged) {
      SDKManager.resignAllClientTokens();
    }
    void this.persistSettingsToDb(nextSettings).catch((err) => {
      console.error("[DataStack Settings] Background DB persist failed:", err);
    });
    void this.notifyIngestionSettingsSync(
      nextSettings,
      previousJwtSecret,
      jwtSecretChanged,
    ).then(() =>
      jwtSecretChanged ? SDKManager.syncAllClientsToIngestionAsync() : undefined,
    );
    return { ...nextSettings };
  }

  public static async updateSettingsAsync(
    updates: AdminSettingsUpdateInput,
  ): Promise<AdminSettings> {
    const current = await this.getSettingsAsync();
    const previousJwtSecret = current.jwtSecret;
    const jwtSecretChanged =
      Boolean(updates.jwtSecret) && updates.jwtSecret !== current.jwtSecret;
    const nextSettings = this.mergeSettingsUpdate(current, updates);

    if (
      jwtSecretChanged &&
      process.env.NODE_ENV === "production" &&
      nextSettings.jwtSecret.trim().length < 32
    ) {
      throw new Error(
        "INVALID_JWT_SECRET: JWT secret must be at least 32 characters in production.",
      );
    }

    if (jwtSecretChanged) {
      // BUG-17: Coordinate Port 4000 BEFORE committing JWT rotation on Port 3000
      // so a bridge rejection or unreachable production ingestion server never causes secret split-brain.
      const preSyncStatus = await this.notifyIngestionSettingsSync(
        nextSettings,
        previousJwtSecret,
        true,
      );

      if (!preSyncStatus.synced) {
        const isExplicitHttpRejection = typeof preSyncStatus.status === "number";
        const isProductionBridgeRequired =
          process.env.NODE_ENV === "production" &&
          Boolean(process.env.INGESTION_INTERNAL_URL);

        if (isExplicitHttpRejection || isProductionBridgeRequired) {
          throw new Error(
            `JWT_ROTATION_BRIDGE_FAILED: Aborted JWT rotation because Port 4000 could not synchronize (${preSyncStatus.error || "bridge error"}).`,
          );
        }
      }

      try {
        await this.persistSettingsToDb(nextSettings);
        globals.__dataStackAdminSettings = nextSettings;
        this.applyRuntimeSettings(
          nextSettings,
          updates.autoPruneDays !== undefined,
          updates.compressAfterDays !== undefined,
        );
        await SDKManager.resignAllClientTokensAsync();
      } catch (err) {
        globals.__dataStackAdminSettings = current;
        this.applyRuntimeSettings(current, false, false);
        await this.persistSettingsToDb(current).catch(() => undefined);
        if (preSyncStatus.synced) {
          await this.notifyIngestionSettingsSync(
            current,
            nextSettings.jwtSecret,
            true,
          ).catch(() => undefined);
        }
        throw err;
      }

      const clientSync = await SDKManager.syncAllClientsToIngestionAsync();
      if (!clientSync.synced && preSyncStatus.synced) {
        globals.__dataStackLastSettingsBridgeSync = {
          attempted: true,
          ok: false,
          synced: false,
          status: clientSync.status,
          error: clientSync.error,
          checkedAt: new Date().toISOString(),
        };
      }
      return { ...nextSettings };
    }

    await this.persistSettingsToDb(nextSettings);
    globals.__dataStackAdminSettings = nextSettings;
    this.applyRuntimeSettings(
      nextSettings,
      updates.autoPruneDays !== undefined,
      updates.compressAfterDays !== undefined,
    );
    await this.notifyIngestionSettingsSync(
      nextSettings,
      previousJwtSecret,
      false,
    );
    return { ...nextSettings };
  }
}

export default SettingsManager;
