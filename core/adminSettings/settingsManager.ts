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

type SettingsGlobals = typeof globalThis & {
  __dataStackAdminSettings?: AdminSettings;
  __dataStackSettingsHydrated?: boolean;
};

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
  private static applyRuntimeSettings(settings: AdminSettings) {
    SecurityEngine.maxEventsPerSec = settings.maxEventsPerSec;
    SecurityEngine.enableIdempotency = settings.enableIdempotency;
    SecurityEngine.maxPayloadSizeBytes = settings.maxPayloadSizeKb * 1024;
    DataBufferEngine.batchFlushThreshold = settings.batchFlushThreshold;
    DataBufferEngine.setFlushInterval(settings.batchFlushIntervalMs);
    if (settings.jwtSecret) {
      AuthService.setSecret(settings.jwtSecret);
    }
    CSVStorageManager.maxFileSizeBytes = settings.fileRotationMb * 1024 * 1024;
    if (settings.autoPruneDays > 0) {
      CSVStorageManager.pruneExpiredPartitions(settings.autoPruneDays);
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
        const loaded: AdminSettings = {
          serverPort: Number(row.server_port) || 4000,
          webPort: Number(row.web_port) || 3000,
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

    try {
      await DatabaseEngine.ensureSchema();
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
    } catch {
      // Ignore DB failure; in-memory state remains active
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

  private static async notifyIngestionSettingsSync(
    settings: AdminSettings,
    authJwtSecret: string,
    jwtSecretChanged: boolean,
  ): Promise<void> {
    const headers = getInternalIngestionHeaders(authJwtSecret);
    if (!headers["x-datastack-internal-secret"]) return;

    const ingestionBaseUrl = (
      process.env.INGESTION_INTERNAL_URL || "http://127.0.0.1:4000"
    ).replace(/\/$/, "");

    try {
      await fetch(`${ingestionBaseUrl}/internal/settings-sync`, {
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
    } catch {
      // Port 4000 may not be running in isolated single-process dev mode
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
    this.applyRuntimeSettings(nextSettings);
    if (jwtSecretChanged) {
      SDKManager.resignAllClientTokens();
    }
    void this.persistSettingsToDb(nextSettings);
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
    globals.__dataStackAdminSettings = nextSettings;
    this.applyRuntimeSettings(nextSettings);
    if (jwtSecretChanged) {
      await SDKManager.resignAllClientTokensAsync();
    }
    await this.persistSettingsToDb(nextSettings);
    await this.notifyIngestionSettingsSync(
      nextSettings,
      previousJwtSecret,
      jwtSecretChanged,
    );
    if (jwtSecretChanged) {
      await SDKManager.syncAllClientsToIngestionAsync();
    }
    return { ...nextSettings };
  }
}

export default SettingsManager;
