import { AuthService, resolveDefaultJwtSecret } from "../auth/jwt";
import { DataBufferEngine } from "../data/buffer";
import { DatabaseEngine } from "../Database/database";
import { SDKManager } from "../sdk/sdkManager";
import {
  SecurityEngine,
  getInternalIngestionHeaders,
} from "../Security/security";
import { CSVStorageManager } from "../Storage/csvStorage";

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
  updatedAt: string;
}

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
};

const PRUNE_COOLDOWN_MS = 60 * 60 * 1000;
const globals = globalThis as SettingsGlobals;

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
    updatedAt: new Date().toISOString(),
  };
}

function getSettingsState(): AdminSettings {
  if (!globals.__dataStackAdminSettings) {
    globals.__dataStackAdminSettings = getDefaultSettings();
  }
  return globals.__dataStackAdminSettings;
}

export class SettingsManager {
  private static applyRuntimeSettings(settings: AdminSettings, forcePrune = false) {
    SecurityEngine.maxEventsPerSec = settings.maxEventsPerSec;
    SecurityEngine.enableIdempotency = settings.enableIdempotency;
    SecurityEngine.maxPayloadSizeBytes = settings.maxPayloadSizeKb * 1024;
    DataBufferEngine.batchFlushThreshold = settings.batchFlushThreshold;
    DataBufferEngine.setFlushInterval(settings.batchFlushIntervalMs);
    if (settings.jwtSecret) {
      AuthService.setSecret(settings.jwtSecret);
    }
    CSVStorageManager.maxFileSizeBytes = settings.fileRotationMb * 1024 * 1024;
    const hasConfiguredDb = Boolean(process.env.DATABASE_URL?.trim());
    if (
      settings.autoPruneDays > 0 &&
      (!hasConfiguredDb || globals.__dataStackSettingsHydrated === true)
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
        void CSVStorageManager.pruneExpiredPartitionsAsync(
          settings.autoPruneDays,
        ).catch((err) => {
          console.warn(
            "[DataStack Storage] Background async partition prune failed:",
            err,
          );
        });
      }
    }
  }

  private static async syncFromDatabase(): Promise<AdminSettings | null> {
    const pool = DatabaseEngine.getPool();
    if (!pool) return null;

    try {
      const ready = await DatabaseEngine.ensureSchema();
      if (!ready) return null;

      const result = await pool.query(
        `SELECT server_port, web_port, max_events_per_sec, max_payload_size_kb,
                batch_flush_threshold, batch_flush_interval_ms, file_rotation_mb,
                jwt_secret, enable_idempotency, auto_prune_days, updated_at
         FROM admin_settings
         WHERE id = 'default'`,
      );

      if (result.rowCount && result.rowCount > 0) {
        const row = result.rows[0];
        const parsedPruneDays =
          row.auto_prune_days !== undefined && row.auto_prune_days !== null
            ? Number(row.auto_prune_days)
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
          jwtSecret: String(row.jwt_secret || "").trim() || resolveDefaultJwtSecret(),
          enableIdempotency: Boolean(row.enable_idempotency),
          autoPruneDays: Number.isFinite(parsedPruneDays) ? parsedPruneDays : 30,
          updatedAt: row.updated_at
            ? new Date(row.updated_at as string | Date).toISOString()
            : new Date().toISOString(),
        };
        globals.__dataStackAdminSettings = loaded;
        globals.__dataStackSettingsHydrated = true;
        this.applyRuntimeSettings(loaded);
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
           jwt_secret, enable_idempotency, auto_prune_days, updated_at
         ) VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
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

  public static getPublicSettings(): Omit<AdminSettings, "jwtSecret"> {
    const settings = this.getSettings();
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
      updatedAt: settings.updatedAt,
    };
  }

  public static async getPublicSettingsAsync(): Promise<
    Omit<AdminSettings, "jwtSecret">
  > {
    const settings = await this.getSettingsAsync();
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
      updatedAt: settings.updatedAt,
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
      const message = err instanceof Error ? err.message : "Port 4000 settings-sync unreachable";
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

  public static updateSettings(updates: Partial<AdminSettings>): AdminSettings {
    const current = getSettingsState();
    const previousJwtSecret = current.jwtSecret;
    const jwtSecretChanged =
      Boolean(updates.jwtSecret) && updates.jwtSecret !== current.jwtSecret;
    const nextSettings: AdminSettings = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    globals.__dataStackAdminSettings = nextSettings;
    this.applyRuntimeSettings(nextSettings, updates.autoPruneDays !== undefined);
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
    updates: Partial<AdminSettings>,
  ): Promise<AdminSettings> {
    const current = await this.getSettingsAsync();
    const previousJwtSecret = current.jwtSecret;
    const jwtSecretChanged =
      Boolean(updates.jwtSecret) && updates.jwtSecret !== current.jwtSecret;
    const nextSettings: AdminSettings = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

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
        this.applyRuntimeSettings(nextSettings, updates.autoPruneDays !== undefined);
        await SDKManager.resignAllClientTokensAsync();
      } catch (err) {
        globals.__dataStackAdminSettings = current;
        this.applyRuntimeSettings(current, false);
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
    this.applyRuntimeSettings(nextSettings, updates.autoPruneDays !== undefined);
    await this.notifyIngestionSettingsSync(
      nextSettings,
      previousJwtSecret,
      false,
    );
    return { ...nextSettings };
  }
}

export default SettingsManager;
