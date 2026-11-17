import { Pool } from "pg";
import { SettingsManager } from "../adminSettings/settingsManager";
import { SDKManager } from "../sdk/sdkManager";

type CoreDatabaseGlobals = typeof globalThis & {
  __dataStackCorePool?: Pool | null;
  __dataStackCoreSchema?: Promise<void>;
};

const globals = globalThis as CoreDatabaseGlobals;

/**
 * Database Module (PostgreSQL Persistence Engine)
 * CRITICAL RULE: PostgreSQL stores strictly administrative metadata,
 * client registrations (client_sdks), and configuration (admin_settings).
 * Collected telemetry streams are NEVER stored in PostgreSQL.
 */
export class DatabaseEngine {
  public static getPool(): Pool | null {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      return null;
    }

    if (globals.__dataStackCorePool === undefined) {
      try {
        globals.__dataStackCorePool = new Pool({
          connectionString,
          connectionTimeoutMillis: 3000,
          idleTimeoutMillis: 30000,
          max: 5,
        });
      } catch {
        globals.__dataStackCorePool = null;
      }
    }

    return globals.__dataStackCorePool ?? null;
  }

  public static async ensureSchema(): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) return false;

    globals.__dataStackCoreSchema ??= Promise.all([
      pool.query(`
        CREATE TABLE IF NOT EXISTS client_sdks (
          client_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          secret TEXT NOT NULL,
          token TEXT NOT NULL,
          rate_limit INTEGER NOT NULL DEFAULT 100,
          status TEXT NOT NULL DEFAULT 'active',
          total_events BIGINT NOT NULL DEFAULT 0,
          last_active TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `),
      pool.query(`
        CREATE TABLE IF NOT EXISTS admin_settings (
          id TEXT PRIMARY KEY DEFAULT 'default',
          server_port INTEGER NOT NULL DEFAULT 4000,
          web_port INTEGER NOT NULL DEFAULT 3000,
          max_events_per_sec INTEGER NOT NULL DEFAULT 100,
          max_payload_size_kb INTEGER NOT NULL DEFAULT 100,
          batch_flush_threshold INTEGER NOT NULL DEFAULT 500,
          batch_flush_interval_ms INTEGER NOT NULL DEFAULT 2000,
          file_rotation_mb INTEGER NOT NULL DEFAULT 100,
          jwt_secret TEXT NOT NULL,
          enable_idempotency BOOLEAN NOT NULL DEFAULT true,
          auto_prune_days INTEGER NOT NULL DEFAULT 30,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `),
      pool.query(`
        CREATE TABLE IF NOT EXISTS deleted_clients (
          client_id TEXT PRIMARY KEY,
          deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `),
      pool.query(`
        CREATE TABLE IF NOT EXISTS admin_users (
          id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          email TEXT NOT NULL UNIQUE,
          password_salt BYTEA NOT NULL,
          password_hash BYTEA NOT NULL,
          token_version INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `),
      pool.query(`
        CREATE TABLE IF NOT EXISTS admin_login_attempts (
          key_hash TEXT PRIMARY KEY,
          window_started_at TIMESTAMPTZ NOT NULL,
          failed_attempts INTEGER NOT NULL,
          blocked_until TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `),
    ]).then(() => undefined);

    try {
      await globals.__dataStackCoreSchema;
      return true;
    } catch {
      globals.__dataStackCoreSchema = undefined;
      return false;
    }
  }

  public static async getHealth() {
    const pool = this.getPool();
    if (!pool) {
      return {
        status: "healthy" as const,
        storageMode: "In-Memory" as const,
        type: "In-Memory Fallback (DATABASE_URL not set)",
        database: "memory",
        role: "Metadata & SDK Registrations Only",
        collectedDataStorage: "Strictly CSV (/storage/data)",
      };
    }

    try {
      await this.ensureSchema();
      await pool.query("SELECT 1");
      return {
        status: "healthy" as const,
        storageMode: "PostgreSQL" as const,
        type: "PostgreSQL Managed Schema",
        database: "datastack_db",
        role: "Metadata & SDK Registrations Only",
        collectedDataStorage: "Strictly CSV (/storage/data)",
      };
    } catch {
      return {
        status: "degraded" as const,
        storageMode: "In-Memory" as const,
        type: "PostgreSQL Unreachable (In-Memory Fallback Active)",
        database: "datastack_db",
        role: "Metadata & SDK Registrations Only",
        collectedDataStorage: "Strictly CSV (/storage/data)",
      };
    }
  }

  public static async syncState() {
    const [clients, settings] = await Promise.all([
      SDKManager.listClientsAsync(),
      SettingsManager.getPublicSettingsAsync(),
    ]);
    return {
      clientsCount: clients.length,
      settings,
    };
  }
}

export default DatabaseEngine;
