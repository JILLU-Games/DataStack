import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { SettingsManager } from "../adminSettings/settingsManager";
import { AuthService } from "../auth/jwt";
import { DataBufferEngine } from "../data/buffer";
import { DatabaseEngine } from "../Database/database";
import { getInternalIngestionHeaders } from "../Security/security";
import { CSVStorageManager } from "../Storage/csvStorage";

export interface BridgeSyncResult {
  synced: boolean;
  status?: number;
  error?: string;
}

const REDIS_CLIENTS_REGISTRY_KEY = "datastack:clients:registry";
const REDIS_CLIENTS_DELETED_KEY = "datastack:clients:deleted";

export interface ClientSDK {
  clientId: string;
  name: string;
  secret: string;
  token: string;
  rateLimit: number; // max events per sec
  storageQuotaMb: number; // max storage in MB per client (0 = unlimited)
  allowedIps: string; // comma-separated IPv4/IPv6/CIDR list ("" = allow all)
  expiresAt?: string | null; // ISO timestamp or null/undefined if never expires
  status: "active" | "revoked";
  totalEvents: number;
  lastActive?: string;
  createdAt: string;
}

type PendingActivityEntry = {
  count: number;
  lastActive: string;
};

type SDKDatabaseGlobals = typeof globalThis & {
  __dataStackClientsMap?: Map<string, ClientSDK>;
  __dataStackDeletedClients?: Set<string>;
  __dataStackClientsHydrated?: boolean;
  __dataStackSyncedSocketEvents?: Map<string, number>;
  __dataStackPendingClientActivity?: Map<string, PendingActivityEntry>;
  __dataStackActivityFlushTimer?: ReturnType<typeof setInterval> | null;
  __dataStackActivityFlushPromise?: Promise<number> | null;
  __dataStackActivityShutdownRegistered?: boolean;
};

const CLIENT_ACTIVITY_FLUSH_INTERVAL_MS = 1000;
const CLIENT_ACTIVITY_IMMEDIATE_BATCH_SIZE = 500;
const globals = globalThis as SDKDatabaseGlobals;

async function ensureDbSettingsHydrated(): Promise<void> {
  if (DatabaseEngine.getPool()) {
    await SettingsManager.getSettingsAsync();
  }
}

function getClientsMap(): Map<string, ClientSDK> {
  if (!globals.__dataStackClientsMap) {
    globals.__dataStackClientsMap = new Map<string, ClientSDK>();
  }
  return globals.__dataStackClientsMap;
}

function getDeletedClientsSet(): Set<string> {
  if (!globals.__dataStackDeletedClients) {
    globals.__dataStackDeletedClients = new Set<string>();
  }
  return globals.__dataStackDeletedClients;
}

function getSyncedSocketEventsMap(): Map<string, number> {
  if (!globals.__dataStackSyncedSocketEvents) {
    globals.__dataStackSyncedSocketEvents = new Map<string, number>();
  }
  return globals.__dataStackSyncedSocketEvents;
}

function getPendingClientActivityMap(): Map<string, PendingActivityEntry> {
  if (!globals.__dataStackPendingClientActivity) {
    globals.__dataStackPendingClientActivity = new Map<
      string,
      PendingActivityEntry
    >();
  }
  return globals.__dataStackPendingClientActivity;
}

function ensureActivityFlushTimer(): void {
  if (globals.__dataStackActivityFlushTimer) return;
  const timer = setInterval(() => {
    void SDKManager.flushPendingClientActivityAsync().catch(() => undefined);
  }, CLIENT_ACTIVITY_FLUSH_INTERVAL_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  globals.__dataStackActivityFlushTimer = timer;
}

interface RemoteInMemoryClient {
  clientId?: string;
  name?: string;
  status?: string;
  token?: string;
  rateLimit?: number;
  storageQuotaMb?: number;
  allowedIps?: string;
  expiresAt?: string | null;
}

function hydrateLocalMapFromRemote(remoteClients: RemoteInMemoryClient[]): number {
  const map = getClientsMap();
  const deletedSet = getDeletedClientsSet();
  let hydrated = 0;
  for (const item of remoteClients) {
    if (!item || !item.clientId) continue;
    const cid = SDKManager.normalizeClientId(item.clientId);
    if (!cid || deletedSet.has(cid) || map.has(cid)) continue;
    map.set(cid, {
      clientId: cid,
      name: String(item.name || cid),
      secret: "",
      token: String(item.token || ""),
      rateLimit: Math.max(1, Number(item.rateLimit) || 100),
      storageQuotaMb: Math.max(0, Math.floor(Number(item.storageQuotaMb) || 0)),
      allowedIps: typeof item.allowedIps === "string" ? item.allowedIps : "",
      expiresAt: item.expiresAt ? String(item.expiresAt) : null,
      status: item.status === "revoked" ? "revoked" : "active",
      totalEvents: 0,
      createdAt: new Date().toISOString(),
    });
    hydrated += 1;
  }
  return hydrated;
}

function serializeSyncClient(client: ClientSDK) {
  return {
    clientId: client.clientId,
    name: client.name,
    status: client.status,
    token: client.token,
    rateLimit: client.rateLimit,
    storageQuotaMb: client.storageQuotaMb,
    allowedIps: client.allowedIps || "",
    expiresAt: client.expiresAt ?? null,
  };
}

async function mirrorClientToRedis(
  clientId: string,
  action: "deleted" | "revoked" | "updated" | "registered",
  client?: ClientSDK,
): Promise<void> {
  const redis = DataBufferEngine.getRedisClient();
  if (!redis) return;
  try {
    if (action === "deleted") {
      if (typeof redis.sadd === "function") {
        await redis.sadd(REDIS_CLIENTS_DELETED_KEY, clientId);
      }
      if (typeof redis.hdel === "function") {
        await redis.hdel(REDIS_CLIENTS_REGISTRY_KEY, clientId);
      }
      return;
    }
    if (action === "registered" && typeof redis.srem === "function") {
      await redis.srem(REDIS_CLIENTS_DELETED_KEY, clientId);
    }
    if (client && typeof redis.hset === "function") {
      await redis.hset(
        REDIS_CLIENTS_REGISTRY_KEY,
        clientId,
        JSON.stringify(serializeSyncClient(client)),
      );
    }
  } catch {
    // Non-fatal; DB and direct HTTP bridge remain primary sources of truth
  }
}

async function notifyIngestionClientSyncAsync(
  clientId: string,
  action: "deleted" | "revoked" | "updated" | "registered",
  client?: ClientSDK,
): Promise<BridgeSyncResult> {
  await mirrorClientToRedis(clientId, action, client);
  const headers = getInternalIngestionHeaders();
  if (!headers["x-datastack-internal-secret"]) {
    return { synced: false, error: "Internal bridge secret is not configured" };
  }
  const ingestionBaseUrl = (
    process.env.INGESTION_INTERNAL_URL || "http://127.0.0.1:4000"
  ).replace(/\/$/, "");
  try {
    const res = await fetch(`${ingestionBaseUrl}/internal/client-sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        clientId,
        action,
        ...(client ? { client: serializeSyncClient(client) } : {}),
      }),
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) {
      const errorMsg = `Port 4000 client-sync (${action}:${clientId}) failed with HTTP ${res.status}`;
      console.warn(`[DataStack Bridge] ${errorMsg}`);
      return { synced: false, status: res.status, error: errorMsg };
    }
    return { synced: true, status: res.status };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Bridge request failed";
    if (
      process.env.NODE_ENV === "production" ||
      Boolean(process.env.INGESTION_INTERNAL_URL)
    ) {
      console.warn(`[DataStack Bridge] Port 4000 client-sync unreachable: ${message}`);
    }
    return { synced: false, error: message };
  }
}

function notifyIngestionClientSync(
  clientId: string,
  action: "deleted" | "revoked" | "updated" | "registered",
  client?: ClientSDK,
): void {
  void notifyIngestionClientSyncAsync(clientId, action, client);
}

function mapRowToClient(row: Record<string, unknown>): ClientSDK {
  const parsedQuota = Number(row.storage_quota_mb);
  let expiresAt: string | null = null;
  if (row.expires_at) {
    const d = new Date(row.expires_at as string | Date);
    if (!Number.isNaN(d.getTime())) {
      expiresAt = d.toISOString();
    }
  }
  return {
    clientId: String(row.client_id),
    name: String(row.name),
    secret: String(row.secret),
    token: String(row.token),
    rateLimit: Number(row.rate_limit) || 100,
    storageQuotaMb:
      Number.isFinite(parsedQuota) && parsedQuota >= 0
        ? Math.floor(parsedQuota)
        : 0,
    allowedIps: typeof row.allowed_ips === "string" ? row.allowed_ips : "",
    expiresAt,
    status: row.status === "revoked" ? "revoked" : "active",
    totalEvents: Number(row.total_events) || 0,
    lastActive: row.last_active
      ? new Date(row.last_active as string | Date).toISOString()
      : undefined,
    createdAt: row.created_at
      ? new Date(row.created_at as string | Date).toISOString()
      : new Date().toISOString(),
  };
}

export class SDKManager {
  private static async syncFromDatabase(): Promise<ClientSDK[] | null> {
    const pool = DatabaseEngine.getPool();
    if (!pool) return null;

    try {
      const ready = await DatabaseEngine.ensureSchema();
      if (!ready) return null;

      if (getPendingClientActivityMap().size > 0) {
        await this.flushPendingClientActivityAsync();
      }

      const [result, deletedResult] = await Promise.all([
        pool.query(
          `SELECT client_id, name, secret, token, rate_limit, storage_quota_mb, allowed_ips, expires_at, status, total_events, last_active, created_at
           FROM client_sdks
           ORDER BY created_at DESC`,
        ),
        pool.query(`SELECT client_id FROM deleted_clients`),
      ]);

      const deletedSet = getDeletedClientsSet();
      deletedSet.clear();
      for (const row of deletedResult.rows) {
        deletedSet.add(String(row.client_id).trim().toLowerCase());
      }

      const map = getClientsMap();
      map.clear();
      const list: ClientSDK[] = [];

      for (const row of result.rows) {
        const client = mapRowToClient(row);
        map.set(client.clientId, client);
        list.push(client);
      }

      globals.__dataStackClientsHydrated = true;
      return list;
    } catch {
      return null;
    }
  }

  public static listClients(): ClientSDK[] {
    if (!globals.__dataStackClientsHydrated) {
      void this.syncFromDatabase();
    }
    return Array.from(getClientsMap().values());
  }

  public static async syncAllClientsToIngestionAsync(options?: {
    forceReplace?: boolean;
  }): Promise<BridgeSyncResult> {
    await ensureDbSettingsHydrated();
    const clients = Array.from(getClientsMap().values()).map(serializeSyncClient);
    const forceReplace = options?.forceReplace ?? Boolean(DatabaseEngine.getPool());
    const redis = DataBufferEngine.getRedisClient();
    if (redis && typeof redis.hset === "function") {
      try {
        for (const c of clients) {
          await redis.hset(REDIS_CLIENTS_REGISTRY_KEY, c.clientId, JSON.stringify(c));
        }
      } catch {
        // ignore Redis mirror failure
      }
    }
    const headers = getInternalIngestionHeaders();
    if (!headers["x-datastack-internal-secret"]) {
      return { synced: false, error: "Internal bridge secret is not configured" };
    }
    const ingestionBaseUrl = (
      process.env.INGESTION_INTERNAL_URL || "http://127.0.0.1:4000"
    ).replace(/\/$/, "");
    try {
      const res = await fetch(`${ingestionBaseUrl}/internal/client-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          action: "bulk_sync",
          clients,
          forceReplace,
        }),
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) {
        const errorMsg = `Port 4000 bulk_sync failed with HTTP ${res.status}`;
        console.warn(`[DataStack Bridge] ${errorMsg}`);
        return { synced: false, status: res.status, error: errorMsg };
      }
      // BUG-02: If Port 4000 preserved an existing no-DB registry because Port 3000 restarted empty,
      // hydrate Port 3000's local map non-destructively from the returned clients.
      try {
        const payload = (await res.json()) as {
          preserved?: boolean;
          clients?: RemoteInMemoryClient[];
        };
        if (
          payload?.preserved &&
          Array.isArray(payload.clients) &&
          payload.clients.length > 0 &&
          !DatabaseEngine.getPool()
        ) {
          hydrateLocalMapFromRemote(payload.clients);
        }
      } catch {
        // Response body optional
      }
      return { synced: true, status: res.status };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Bridge bulk_sync unreachable";
      if (
        process.env.NODE_ENV === "production" ||
        Boolean(process.env.INGESTION_INTERNAL_URL)
      ) {
        console.warn(`[DataStack Bridge] ${message}`);
      }
      return { synced: false, error: message };
    }
  }

  public static async listClientsAsync(): Promise<ClientSDK[]> {
    await ensureDbSettingsHydrated();
    const fromDb = await this.syncFromDatabase();
    if (fromDb !== null) {
      return fromDb;
    }

    const map = getClientsMap();
    const headers = getInternalIngestionHeaders();
    if (headers["x-datastack-internal-secret"]) {
      const ingestionBaseUrl = (
        process.env.INGESTION_INTERNAL_URL || "http://127.0.0.1:4000"
      ).replace(/\/$/, "");
      try {
        const res = await fetch(`${ingestionBaseUrl}/internal/metrics`, {
          headers,
          cache: "no-store",
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            hasSyncedInMemoryClients?: boolean;
            inMemoryClients?: RemoteInMemoryClient[];
            clientActivity?: Record<
              string,
              { totalEvents?: number; lastActive?: string }
            >;
          };
          // BUG-02: Non-destructive hydration when Port 3000 restarted empty while Port 4000 still holds clients
          if (
            map.size === 0 &&
            Array.isArray(data.inMemoryClients) &&
            data.inMemoryClients.length > 0
          ) {
            hydrateLocalMapFromRemote(data.inMemoryClients);
          } else if (data.hasSyncedInMemoryClients === false && map.size > 0) {
            await this.syncAllClientsToIngestionAsync();
          }
          if (data.clientActivity && typeof data.clientActivity === "object") {
            const syncedMap = getSyncedSocketEventsMap();
            for (const [cid, activity] of Object.entries(data.clientActivity)) {
              const client = map.get(cid);
              if (!client) continue;
              const remoteTotal = Math.max(0, Number(activity?.totalEvents) || 0);
              const prevSynced = syncedMap.get(cid) || 0;
              const delta =
                remoteTotal >= prevSynced
                  ? remoteTotal - prevSynced
                  : remoteTotal;
              if (delta > 0) {
                client.totalEvents += delta;
              }
              syncedMap.set(cid, remoteTotal);
              if (
                activity?.lastActive &&
                (!client.lastActive || activity.lastActive > client.lastActive)
              ) {
                client.lastActive = activity.lastActive;
              }
              map.set(cid, client);
            }
          }
        }
      } catch {
        // Port 4000 may not be running in isolated single-process dev mode
      }
    }

    return Array.from(map.values());
  }

  public static normalizeClientId(clientId: string): string {
    return String(clientId || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_");
  }

  public static getClient(clientId: string): ClientSDK | undefined {
    const normalizedId = this.normalizeClientId(clientId);
    if (!normalizedId) return undefined;
    return getClientsMap().get(normalizedId);
  }

  public static async getClientAsync(
    clientId: string,
  ): Promise<ClientSDK | undefined> {
    await ensureDbSettingsHydrated();
    const normalizedId = this.normalizeClientId(clientId);
    if (!normalizedId) return undefined;
    const pool = DatabaseEngine.getPool();
    if (pool) {
      try {
        await DatabaseEngine.ensureSchema();
        if (getPendingClientActivityMap().has(normalizedId)) {
          await this.flushPendingClientActivityAsync();
        }
        const result = await pool.query(
          `SELECT client_id, name, secret, token, rate_limit, storage_quota_mb, allowed_ips, expires_at, status, total_events, last_active, created_at
           FROM client_sdks
           WHERE client_id = $1`,
          [normalizedId],
        );
        if (result.rowCount && result.rowCount > 0) {
          const client = mapRowToClient(result.rows[0]);
          getClientsMap().set(client.clientId, client);
          return client;
        }
        getClientsMap().delete(normalizedId);
        return undefined;
      } catch {
        // Fall back to in-memory map
      }
    }
    const existing = getClientsMap().get(normalizedId);
    if (existing) {
      return existing;
    }
    // BUG-02: If Port 3000 restarted without DB and local map is empty, attempt non-destructive hydration from Port 4000
    if (getClientsMap().size === 0 && !getDeletedClientsSet().has(normalizedId)) {
      await this.listClientsAsync();
      return getClientsMap().get(normalizedId);
    }
    return undefined;
  }

  private static generateClientSecret(safeClientId: string): string {
    return `sec_${safeClientId}_${randomBytes(16).toString("hex")}`;
  }

  public static registerClient(data: {
    clientId: string;
    name: string;
    rateLimit?: number;
    storageQuotaMb?: number;
    allowedIps?: string;
    expiresAt?: string | null;
  }): ClientSDK {
    const safeClientId = this.normalizeClientId(data.clientId);
    const secret = this.generateClientSecret(safeClientId);
    const rateLimit = Math.max(1, Number(data.rateLimit) || 100);
    const storageQuotaMb = Math.max(
      0,
      Math.floor(Number(data.storageQuotaMb) || 0),
    );
    const allowedIps = typeof data.allowedIps === "string" ? data.allowedIps.trim() : "";
    const expiresAt = data.expiresAt ? String(data.expiresAt) : null;

    const token = AuthService.generateClientToken({
      clientId: safeClientId,
      name: data.name.trim(),
      rateLimit,
    });

    const newClient: ClientSDK = {
      clientId: safeClientId,
      name: data.name.trim(),
      secret,
      token,
      rateLimit,
      storageQuotaMb,
      allowedIps,
      expiresAt,
      status: "active",
      totalEvents: 0,
      createdAt: new Date().toISOString(),
    };

    getDeletedClientsSet().delete(safeClientId);
    DataBufferEngine.unmarkClientDeleted(safeClientId);
    getSyncedSocketEventsMap().delete(safeClientId);
    getClientsMap().set(safeClientId, newClient);
    void this.persistNewClient(newClient).catch((err) => {
      console.error("[DataStack SDK] Background client create DB persist failed:", err);
    });
    notifyIngestionClientSync(safeClientId, "registered", newClient);
    return newClient;
  }

  private static async persistNewClient(client: ClientSDK): Promise<void> {
    const pool = DatabaseEngine.getPool();
    if (!pool) return;

    const ready = await DatabaseEngine.ensureSchema();
    if (!ready) {
      throw new Error("DATABASE_WRITE_FAILED: PostgreSQL schema unavailable for client registration.");
    }

    try {
      await pool.query(
        `DELETE FROM deleted_clients WHERE client_id = $1`,
        [client.clientId],
      );
      await pool.query(
        `INSERT INTO client_sdks (client_id, name, secret, token, rate_limit, storage_quota_mb, allowed_ips, expires_at, status, total_events, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (client_id) DO UPDATE SET
           name = EXCLUDED.name,
           secret = EXCLUDED.secret,
           token = EXCLUDED.token,
           rate_limit = EXCLUDED.rate_limit,
           storage_quota_mb = EXCLUDED.storage_quota_mb,
           allowed_ips = EXCLUDED.allowed_ips,
           expires_at = EXCLUDED.expires_at,
           status = EXCLUDED.status,
           updated_at = NOW()`,
        [
          client.clientId,
          client.name,
          client.secret,
          client.token,
          client.rateLimit,
          client.storageQuotaMb,
          client.allowedIps || "",
          client.expiresAt ?? null,
          client.status,
          client.totalEvents,
          client.createdAt,
        ],
      );
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : "Unknown DB error";
      throw new Error(`DATABASE_WRITE_FAILED: Failed to register client (${detail})`);
    }
  }

  public static async registerClientAsync(data: {
    clientId: string;
    name: string;
    rateLimit?: number;
    storageQuotaMb?: number;
    allowedIps?: string;
    expiresAt?: string | null;
  }): Promise<ClientSDK> {
    await ensureDbSettingsHydrated();
    const safeClientId = this.normalizeClientId(data.clientId);
    const secret = this.generateClientSecret(safeClientId);
    const rateLimit = Math.max(1, Number(data.rateLimit) || 100);
    const storageQuotaMb = Math.max(
      0,
      Math.floor(Number(data.storageQuotaMb) || 0),
    );
    const allowedIps = typeof data.allowedIps === "string" ? data.allowedIps.trim() : "";
    const expiresAt = data.expiresAt ? String(data.expiresAt) : null;

    const token = AuthService.generateClientToken({
      clientId: safeClientId,
      name: data.name.trim(),
      rateLimit,
    });

    const newClient: ClientSDK = {
      clientId: safeClientId,
      name: data.name.trim(),
      secret,
      token,
      rateLimit,
      storageQuotaMb,
      allowedIps,
      expiresAt,
      status: "active",
      totalEvents: 0,
      createdAt: new Date().toISOString(),
    };

    await this.persistNewClient(newClient);
    getDeletedClientsSet().delete(safeClientId);
    DataBufferEngine.unmarkClientDeleted(safeClientId);
    getSyncedSocketEventsMap().delete(safeClientId);
    getClientsMap().set(safeClientId, newClient);
    await notifyIngestionClientSyncAsync(safeClientId, "registered", newClient);
    return newClient;
  }

  public static regenerateToken(clientId: string): ClientSDK | null {
    const normalizedId = this.normalizeClientId(clientId);
    const client = getClientsMap().get(normalizedId);
    if (!client) return null;

    const updated: ClientSDK = {
      ...client,
      secret: this.generateClientSecret(normalizedId),
      token: AuthService.generateClientToken({
        clientId: client.clientId,
        name: client.name,
        rateLimit: client.rateLimit,
      }),
    };

    getClientsMap().set(normalizedId, updated);
    void this.persistClientCredentials(updated).catch((err) => {
      console.error("[DataStack SDK] Background token rotate DB persist failed:", err);
    });
    notifyIngestionClientSync(normalizedId, "updated", updated);
    return updated;
  }

  private static async persistClientCredentials(
    client: ClientSDK,
  ): Promise<void> {
    const pool = DatabaseEngine.getPool();
    if (!pool) return;

    const ready = await DatabaseEngine.ensureSchema();
    if (!ready) {
      throw new Error("DATABASE_WRITE_FAILED: PostgreSQL schema unavailable for credential update.");
    }

    try {
      await pool.query(
        `UPDATE client_sdks
         SET secret = $2, token = $3, updated_at = NOW()
         WHERE client_id = $1`,
        [client.clientId, client.secret, client.token],
      );
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : "Unknown DB error";
      throw new Error(`DATABASE_WRITE_FAILED: Failed to update client credentials (${detail})`);
    }
  }

  public static async regenerateTokenAsync(
    clientId: string,
  ): Promise<ClientSDK | null> {
    await ensureDbSettingsHydrated();
    const normalizedId = this.normalizeClientId(clientId);
    const existing = await this.getClientAsync(normalizedId);
    if (!existing) return null;

    const updated: ClientSDK = {
      ...existing,
      secret: this.generateClientSecret(normalizedId),
      token: AuthService.generateClientToken({
        clientId: existing.clientId,
        name: existing.name,
        rateLimit: existing.rateLimit,
      }),
    };

    await this.persistClientCredentials(updated);
    getClientsMap().set(normalizedId, updated);
    await notifyIngestionClientSyncAsync(normalizedId, "updated", updated);
    return updated;
  }

  public static updateClient(
    clientId: string,
    updates: Partial<
      Pick<
        ClientSDK,
        | "name"
        | "rateLimit"
        | "storageQuotaMb"
        | "allowedIps"
        | "expiresAt"
        | "status"
      >
    >,
  ): ClientSDK | null {
    const normalizedId = this.normalizeClientId(clientId);
    const client = getClientsMap().get(normalizedId);
    if (!client) return null;

    const updated: ClientSDK = {
      ...client,
      ...(updates.name !== undefined ? { name: updates.name.trim() } : {}),
      ...(updates.rateLimit !== undefined
        ? { rateLimit: Math.max(1, Number(updates.rateLimit) || 100) }
        : {}),
      ...(updates.storageQuotaMb !== undefined
        ? {
            storageQuotaMb: Math.max(
              0,
              Math.floor(Number(updates.storageQuotaMb) || 0),
            ),
          }
        : {}),
      ...(updates.allowedIps !== undefined
        ? { allowedIps: String(updates.allowedIps).trim() }
        : {}),
      ...(updates.expiresAt !== undefined
        ? { expiresAt: updates.expiresAt ? String(updates.expiresAt) : null }
        : {}),
      ...(updates.status !== undefined ? { status: updates.status } : {}),
    };

    getClientsMap().set(normalizedId, updated);
    void this.persistClientUpdates(updated).catch((err) => {
      console.error("[DataStack SDK] Background client update DB persist failed:", err);
    });
    notifyIngestionClientSync(
      normalizedId,
      updated.status === "revoked" ? "revoked" : "updated",
      updated,
    );
    return updated;
  }

  private static async persistClientUpdates(client: ClientSDK): Promise<void> {
    const pool = DatabaseEngine.getPool();
    if (!pool) return;

    const ready = await DatabaseEngine.ensureSchema();
    if (!ready) {
      throw new Error("DATABASE_WRITE_FAILED: PostgreSQL schema unavailable for client update.");
    }

    try {
      await pool.query(
        `UPDATE client_sdks
         SET name = $2, rate_limit = $3, storage_quota_mb = $4, allowed_ips = $5, expires_at = $6, status = $7, updated_at = NOW()
         WHERE client_id = $1`,
        [
          client.clientId,
          client.name,
          client.rateLimit,
          client.storageQuotaMb,
          client.allowedIps || "",
          client.expiresAt ?? null,
          client.status,
        ],
      );
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : "Unknown DB error";
      throw new Error(`DATABASE_WRITE_FAILED: Failed to update client (${detail})`);
    }
  }

  public static async updateClientAsync(
    clientId: string,
    updates: Partial<
      Pick<
        ClientSDK,
        | "name"
        | "rateLimit"
        | "storageQuotaMb"
        | "allowedIps"
        | "expiresAt"
        | "status"
      >
    >,
  ): Promise<ClientSDK | null> {
    await ensureDbSettingsHydrated();
    const normalizedId = this.normalizeClientId(clientId);
    const client = await this.getClientAsync(normalizedId);
    if (!client) return null;

    const updated: ClientSDK = {
      ...client,
      ...(updates.name !== undefined ? { name: updates.name.trim() } : {}),
      ...(updates.rateLimit !== undefined
        ? { rateLimit: Math.max(1, Number(updates.rateLimit) || 100) }
        : {}),
      ...(updates.storageQuotaMb !== undefined
        ? {
            storageQuotaMb: Math.max(
              0,
              Math.floor(Number(updates.storageQuotaMb) || 0),
            ),
          }
        : {}),
      ...(updates.allowedIps !== undefined
        ? { allowedIps: String(updates.allowedIps).trim() }
        : {}),
      ...(updates.expiresAt !== undefined
        ? { expiresAt: updates.expiresAt ? String(updates.expiresAt) : null }
        : {}),
      ...(updates.status !== undefined ? { status: updates.status } : {}),
    };

    await this.persistClientUpdates(updated);
    getClientsMap().set(normalizedId, updated);
    await notifyIngestionClientSyncAsync(
      normalizedId,
      updated.status === "revoked" ? "revoked" : "updated",
      updated,
    );
    return updated;
  }

  public static isClientDeleted(clientId: string): boolean {
    const normalized = this.normalizeClientId(clientId);
    return getDeletedClientsSet().has(normalized);
  }

  public static async isClientDeletedAsync(clientId: string): Promise<boolean> {
    const normalized = this.normalizeClientId(clientId);
    if (!normalized) return false;
    if (getDeletedClientsSet().has(normalized)) {
      return true;
    }

    const pool = DatabaseEngine.getPool();
    if (!pool) return false;

    await DatabaseEngine.ensureSchema();
    const res = await pool.query(
      `SELECT 1 FROM deleted_clients WHERE client_id = $1`,
      [normalized],
    );
    if (res.rowCount && res.rowCount > 0) {
      getDeletedClientsSet().add(normalized);
      return true;
    }
    return false;
  }

  public static deleteClient(clientId: string): boolean {
    const normalized = this.normalizeClientId(clientId);
    const deleted = getClientsMap().delete(normalized);
    getSyncedSocketEventsMap().delete(normalized);
    getPendingClientActivityMap().delete(normalized);
    if (deleted) {
      getDeletedClientsSet().add(normalized);
      DataBufferEngine.markClientDeleted(normalized);
      void DataBufferEngine.purgeClientEventsAsync(normalized).catch(() => undefined);
    }
    void this.deleteClientFromDb(normalized).catch((err) => {
      console.error("[DataStack SDK] Background client delete DB persist failed:", err);
    });
    notifyIngestionClientSync(normalized, "deleted");
    return deleted;
  }

  private static async deleteClientFromDb(clientId: string): Promise<boolean> {
    const pool = DatabaseEngine.getPool();
    if (!pool) return false;

    const ready = await DatabaseEngine.ensureSchema();
    if (!ready) {
      throw new Error("DATABASE_WRITE_FAILED: PostgreSQL schema unavailable for client deletion.");
    }
    const dbClient = await pool.connect();
    try {
      await dbClient.query("BEGIN");
      const res = await dbClient.query(
        `DELETE FROM client_sdks WHERE client_id = $1`,
        [clientId],
      );
      if (res.rowCount && res.rowCount > 0) {
        await dbClient.query(
          `INSERT INTO deleted_clients (client_id, deleted_at)
           VALUES ($1, NOW())
           ON CONFLICT (client_id) DO UPDATE SET deleted_at = NOW()`,
          [clientId],
        );
        await dbClient.query("COMMIT");
        return true;
      }
      await dbClient.query("ROLLBACK");
      return false;
    } catch (err: unknown) {
      await dbClient.query("ROLLBACK").catch(() => undefined);
      const detail = err instanceof Error ? err.message : "Unknown DB error";
      throw new Error(`DATABASE_WRITE_FAILED: Failed to delete client (${detail})`);
    } finally {
      dbClient.release();
    }
  }

  private static purgeClientStorageDir(clientId: string): number {
    const safeId = clientId.replace(/[^a-z0-9_-]/gi, "_");
    if (!safeId) return 0;
    const storageRoot = resolve(CSVStorageManager.baseStorageDir);
    const targetDir = resolve(storageRoot, safeId);
    if (!targetDir.startsWith(`${storageRoot}${sep}`)) return 0;
    if (!existsSync(targetDir)) return 0;

    let purgedFiles = 0;
    try {
      const dirStat = lstatSync(targetDir);
      if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
        for (const entry of readdirSync(targetDir)) {
          if (!CSVStorageManager.isPartitionFilename(entry)) continue;
          const entryPath = resolve(targetDir, entry);
          try {
            const entryStat = lstatSync(entryPath);
            if (!entryStat.isSymbolicLink() && entryStat.isFile()) {
              purgedFiles += 1;
            }
          } catch {
            // Ignore unreadable file entry during pre-purge count
          }
        }
      }
    } catch {
      purgedFiles = 0;
    }

    rmSync(targetDir, { recursive: true, force: true });
    CSVStorageManager.clearRowCountCache();
    CSVStorageManager.clearQuotaCaches(safeId);
    return purgedFiles;
  }

  public static async deleteClientWithStatsAsync(
    clientId: string,
    options?: { purgeFiles?: boolean },
  ): Promise<{ deleted: boolean; purgedFiles: number }> {
    await ensureDbSettingsHydrated();
    const normalized = this.normalizeClientId(clientId);
    getPendingClientActivityMap().delete(normalized);
    const deletedFromDb = await this.deleteClientFromDb(normalized);
    const existedInMem = getClientsMap().delete(normalized);
    getSyncedSocketEventsMap().delete(normalized);
    let purgedFiles = 0;
    if (existedInMem || deletedFromDb) {
      getDeletedClientsSet().add(normalized);
      DataBufferEngine.markClientDeleted(normalized);
      await DataBufferEngine.purgeClientEventsAsync(normalized);
      await notifyIngestionClientSyncAsync(normalized, "deleted");
      if (options?.purgeFiles) {
        purgedFiles = this.purgeClientStorageDir(normalized);
      }
    }
    return { deleted: existedInMem || deletedFromDb, purgedFiles };
  }

  public static async deleteClientAsync(
    clientId: string,
    options?: { purgeFiles?: boolean },
  ): Promise<boolean> {
    const result = await this.deleteClientWithStatsAsync(clientId, options);
    return result.deleted;
  }

  private static queuePendingActivityDelta(
    normalizedId: string,
    count: number,
    nowIso: string,
  ): number {
    const pending = getPendingClientActivityMap();
    const existing = pending.get(normalizedId);
    if (existing) {
      pending.set(normalizedId, {
        count: existing.count + count,
        lastActive:
          nowIso > existing.lastActive ? nowIso : existing.lastActive,
      });
    } else {
      pending.set(normalizedId, {
        count,
        lastActive: nowIso,
      });
    }
    ensureActivityFlushTimer();
    let totalDelta = 0;
    for (const entry of pending.values()) {
      totalDelta += entry.count;
    }
    return totalDelta;
  }

  public static async flushPendingClientActivityAsync(): Promise<number> {
    if (globals.__dataStackActivityFlushPromise) {
      await globals.__dataStackActivityFlushPromise;
      if (getPendingClientActivityMap().size === 0) return 0;
    }

    const pool = DatabaseEngine.getPool();
    const pending = getPendingClientActivityMap();
    if (!pool || pending.size === 0) return 0;

    const snapshot = Array.from(pending.entries());
    pending.clear();

    const clientIds: string[] = [];
    const deltas: number[] = [];
    const lastActives: string[] = [];
    for (const [cid, entry] of snapshot) {
      clientIds.push(cid);
      deltas.push(entry.count);
      lastActives.push(entry.lastActive);
    }

    const run = (async () => {
      try {
        await DatabaseEngine.ensureSchema();
        await pool.query(
          `UPDATE client_sdks AS c
           SET total_events = c.total_events + v.delta,
               last_active = GREATEST(COALESCE(c.last_active, v.last_active), v.last_active),
               updated_at = NOW()
           FROM (
             SELECT UNNEST($1::text[]) AS client_id,
                    UNNEST($2::bigint[]) AS delta,
                    UNNEST($3::timestamptz[]) AS last_active
           ) AS v
           WHERE c.client_id = v.client_id`,
          [clientIds, deltas, lastActives],
        );
        return clientIds.length;
      } catch {
        // Re-merge deltas so transient DB errors do not drop event counts
        for (const [cid, entry] of snapshot) {
          const current = pending.get(cid);
          if (current) {
            pending.set(cid, {
              count: current.count + entry.count,
              lastActive:
                current.lastActive > entry.lastActive
                  ? current.lastActive
                  : entry.lastActive,
            });
          } else {
            pending.set(cid, { ...entry });
          }
        }
        return 0;
      } finally {
        globals.__dataStackActivityFlushPromise = null;
      }
    })();

    globals.__dataStackActivityFlushPromise = run;
    return run;
  }

  public static stopActivityFlushTimerForTests(): void {
    if (globals.__dataStackActivityFlushTimer) {
      clearInterval(globals.__dataStackActivityFlushTimer);
      globals.__dataStackActivityFlushTimer = null;
    }
  }

  public static incrementEventCount(clientId: string, count = 1): void {
    const normalizedId = this.normalizeClientId(clientId);
    if (!normalizedId || count <= 0) return;
    const nowIso = new Date().toISOString();
    const client = getClientsMap().get(normalizedId);
    if (client) {
      client.totalEvents += count;
      client.lastActive = nowIso;
      getClientsMap().set(normalizedId, client);
    }

    if (DatabaseEngine.getPool()) {
      const queuedTotal = this.queuePendingActivityDelta(
        normalizedId,
        count,
        nowIso,
      );
      if (queuedTotal >= CLIENT_ACTIVITY_IMMEDIATE_BATCH_SIZE) {
        void this.flushPendingClientActivityAsync().catch(() => undefined);
      }
    }
  }

  public static async incrementEventCountAsync(
    clientId: string,
    count = 1,
  ): Promise<void> {
    const normalizedId = this.normalizeClientId(clientId);
    if (!normalizedId || count <= 0) return;
    const nowIso = new Date().toISOString();
    const client = getClientsMap().get(normalizedId);
    if (client) {
      client.totalEvents += count;
      client.lastActive = nowIso;
      getClientsMap().set(normalizedId, client);
    }

    // BUG-22: Coalesce per-event DB updates into batched UNNEST writes instead of 1 SQL query/event
    if (DatabaseEngine.getPool()) {
      const queuedTotal = this.queuePendingActivityDelta(
        normalizedId,
        count,
        nowIso,
      );
      if (queuedTotal >= CLIENT_ACTIVITY_IMMEDIATE_BATCH_SIZE) {
        await this.flushPendingClientActivityAsync();
      }
    }
  }

  public static resignAllClientTokens(): void {
    const map = getClientsMap();
    for (const [clientId, client] of map.entries()) {
      client.token = AuthService.generateClientToken({
        clientId: client.clientId,
        name: client.name,
        rateLimit: client.rateLimit,
      });
      map.set(clientId, client);
      void this.persistClientCredentials(client).catch((err) => {
        console.error("[DataStack SDK] Background re-sign DB persist failed:", err);
      });
    }
  }

  public static async resignAllClientTokensAsync(): Promise<void> {
    const clients = await this.listClientsAsync();
    const map = getClientsMap();
    for (const client of clients) {
      const updated: ClientSDK = {
        ...client,
        token: AuthService.generateClientToken({
          clientId: client.clientId,
          name: client.name,
          rateLimit: client.rateLimit,
        }),
      };
      await this.persistClientCredentials(updated);
      map.set(updated.clientId, updated);
    }
  }
}

if (!globals.__dataStackActivityShutdownRegistered) {
  globals.__dataStackActivityShutdownRegistered = true;
  DataBufferEngine.registerShutdownHook(() =>
    SDKManager.flushPendingClientActivityAsync(),
  );
}

export default SDKManager;
