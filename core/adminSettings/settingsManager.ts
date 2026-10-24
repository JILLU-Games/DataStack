import { AuthService } from "../auth/jwt";
import { DataBufferEngine } from "../data/buffer";
import { SecurityEngine } from "../Security/security";
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

export class SettingsManager {
  private static settings: AdminSettings = {
    serverPort: 4000,
    webPort: 3000,
    maxEventsPerSec: 100,
    maxPayloadSizeKb: 100,
    batchFlushThreshold: 500,
    batchFlushIntervalMs: 2000,
    fileRotationMb: 100,
    jwtSecret: process.env.DATASTACK_JWT_SECRET || "",
    enableIdempotency: true,
    autoPruneDays: 30,
    updatedAt: new Date().toISOString(),
  };

  public static getSettings(): AdminSettings {
    return { ...this.settings };
  }

  public static getPublicSettings(): Omit<AdminSettings, "jwtSecret"> {
    const settings = this.settings;
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

  public static updateSettings(updates: Partial<AdminSettings>): AdminSettings {
    this.settings = {
      ...this.settings,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    // Apply live updates to subsystems
    if (updates.maxEventsPerSec !== undefined) {
      SecurityEngine.maxEventsPerSec = updates.maxEventsPerSec;
    }
    if (updates.enableIdempotency !== undefined) {
      SecurityEngine.enableIdempotency = updates.enableIdempotency;
    }
    if (updates.maxPayloadSizeKb !== undefined) {
      SecurityEngine.maxPayloadSizeBytes = updates.maxPayloadSizeKb * 1024;
    }
    if (updates.batchFlushThreshold !== undefined) {
      DataBufferEngine.batchFlushThreshold = updates.batchFlushThreshold;
    }
    if (updates.batchFlushIntervalMs !== undefined) {
      DataBufferEngine.batchFlushIntervalMs = updates.batchFlushIntervalMs;
    }
    if (updates.jwtSecret !== undefined) {
      AuthService.setSecret(updates.jwtSecret);
    }
    if (updates.fileRotationMb !== undefined) {
      CSVStorageManager.maxFileSizeBytes = updates.fileRotationMb * 1024 * 1024;
    }

    return this.settings;
  }
}

export default SettingsManager;
