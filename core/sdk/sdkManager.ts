import { existsSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { SettingsManager } from "../adminSettings/settingsManager";
import { AuthService } from "../auth/jwt";
import { DatabaseEngine } from "../Database/database";
import { getInternalIngestionHeaders } from "../Security/security";

export interface ClientSDK {
  clientId: string;
  name: string;
  secret: string;
  token: string;
  rateLimit: number; // max events per sec
  status: "active" | "revoked";
  totalEvents: number;
  lastActive?: string;
  createdAt: string;
}

type SDKDatabaseGlobals = typeof globalThis & {
  __dataStackClientsMap?: Map<string, ClientSDK>;
  __dataStackDeletedClients?: Set<string>;
  __dataStackClientsHydrated?: boolean;
  __dataStackSyncedSocketEvents?: Map<string, number>;
};

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

function serializeSyncClient(client: ClientSDK) {
  return {
    clientId: client.clientId,
    name: client.name,
    status: client.status,
    token: client.token,
    rateLimit: client.rateLimit,
  };
}

async function notifyIngestionClientSyncAsync(
  clientId: string,
  action: "deleted" | "revoked" | "updated" | "registered",
  client?: ClientSDK,
): Promise<void> {
  const headers = getInternalIngestionHeaders();
  if (!headers["x-datastack-internal-secret"]) return;
  const ingestionBaseUrl = (
    process.env.INGESTION_INTERNAL_URL || "http://127.0.0.1:4000"
  ).replace(/\/$/, "");
  try {
    await fetch(`${ingestionBaseUrl}/internal/client-sync`, {
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
  } catch {
    // Port 4000 may not be running in isolated single-process dev mode
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
  return {
    clientId: String(row.client_id),
    name: String(row.name),
    secret: String(row.secret),
    token: String(row.token),
    rateLimit: Number(row.rate_limit) || 100,
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

      const [result, deletedResult] = await Promise.all([
        pool.query(
          `SELECT client_id, name, secret, token, rate_limit, status, total_events, last_active, created_at
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

  public static async syncAllClientsToIngestionAsync(): Promise<void> {
    await ensureDbSettingsHydrated();
    const headers = getInternalIngestionHeaders();
    if (!headers["x-datastack-internal-secret"]) return;
    const ingestionBaseUrl = (
      process.env.INGESTION_INTERNAL_URL || "http://127.0.0.1:4000"
    ).replace(/\/$/, "");
    const clients = Array.from(getClientsMap().values()).map(serializeSyncClient);
    try {
      await fetch(`${ingestionBaseUrl}/internal/client-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          action: "bulk_sync",
          clients,
        }),
        signal: AbortSignal.timeout(1500),
      });
    } catch {
      // Port 4000 may not be running in isolated single-process dev mode
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
            clientActivity?: Record<
              string,
              { totalEvents?: number; lastActive?: string }
            >;
          };
          if (data.hasSyncedInMemoryClients === false && map.size > 0) {
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

  public static getClient(clientId: string): ClientSDK | undefined {
    return getClientsMap().get(clientId);
  }

  public static async getClientAsync(
    clientId: string,
  ): Promise<ClientSDK | undefined> {
    await ensureDbSettingsHydrated();
    const pool = DatabaseEngine.getPool();
    if (pool) {
      try {
        await DatabaseEngine.ensureSchema();
        const result = await pool.query(
          `SELECT client_id, name, secret, token, rate_limit, status, total_events, last_active, created_at
           FROM client_sdks
           WHERE client_id = $1`,
          [clientId],
        );
        if (result.rowCount && result.rowCount > 0) {
          const client = mapRowToClient(result.rows[0]);
          getClientsMap().set(client.clientId, client);
          return client;
        }
        getClientsMap().delete(clientId);
        return undefined;
      } catch {
        // Fall back to in-memory map
      }
    }
    return getClientsMap().get(clientId);
  }

  public static registerClient(data: {
    clientId: string;
    name: string;
    rateLimit?: number;
  }): ClientSDK {
    const safeClientId = data.clientId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_");
    const secret = `sec_${safeClientId}_${Math.random().toString(36).substring(2, 10)}`;
    const rateLimit = Math.max(1, Number(data.rateLimit) || 100);

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
      status: "active",
      totalEvents: 0,
      createdAt: new Date().toISOString(),
    };

    getDeletedClientsSet().delete(safeClientId);
    getClientsMap().set(safeClientId, newClient);
    void this.persistNewClient(newClient);
    notifyIngestionClientSync(safeClientId, "registered", newClient);
    return newClient;
  }

  private static async persistNewClient(client: ClientSDK): Promise<void> {
    const pool = DatabaseEngine.getPool();
    if (!pool) return;

    try {
      await DatabaseEngine.ensureSchema();
      await pool.query(
        `DELETE FROM deleted_clients WHERE client_id = $1`,
        [client.clientId],
      );
      await pool.query(
        `INSERT INTO client_sdks (client_id, name, secret, token, rate_limit, status, total_events, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (client_id) DO UPDATE SET
           name = EXCLUDED.name,
           secret = EXCLUDED.secret,
           token = EXCLUDED.token,
           rate_limit = EXCLUDED.rate_limit,
           status = EXCLUDED.status,
           updated_at = NOW()`,
        [
          client.clientId,
          client.name,
          client.secret,
          client.token,
          client.rateLimit,
          client.status,
          client.totalEvents,
          client.createdAt,
        ],
      );
    } catch {
      // In-memory map already updated
    }
  }

  public static async registerClientAsync(data: {
    clientId: string;
    name: string;
    rateLimit?: number;
  }): Promise<ClientSDK> {
    await ensureDbSettingsHydrated();
    const safeClientId = data.clientId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_");
    const secret = `sec_${safeClientId}_${Math.random().toString(36).substring(2, 10)}`;
    const rateLimit = Math.max(1, Number(data.rateLimit) || 100);

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
      status: "active",
      totalEvents: 0,
      createdAt: new Date().toISOString(),
    };

    getDeletedClientsSet().delete(safeClientId);
    getClientsMap().set(safeClientId, newClient);
    await this.persistNewClient(newClient);
    await notifyIngestionClientSyncAsync(safeClientId, "registered", newClient);
    return newClient;
  }

  public static regenerateToken(clientId: string): ClientSDK | null {
    const client = getClientsMap().get(clientId);
    if (!client) return null;

    const updated: ClientSDK = {
      ...client,
      secret: `sec_${clientId}_${Math.random().toString(36).substring(2, 10)}`,
      token: AuthService.generateClientToken({
        clientId: client.clientId,
        name: client.name,
        rateLimit: client.rateLimit,
      }),
    };

    getClientsMap().set(clientId, updated);
    void this.persistClientCredentials(updated);
    notifyIngestionClientSync(clientId, "updated", updated);
    return updated;
  }

  private static async persistClientCredentials(
    client: ClientSDK,
  ): Promise<void> {
    const pool = DatabaseEngine.getPool();
    if (!pool) return;

    try {
      await DatabaseEngine.ensureSchema();
      await pool.query(
        `UPDATE client_sdks
         SET secret = $2, token = $3, updated_at = NOW()
         WHERE client_id = $1`,
        [client.clientId, client.secret, client.token],
      );
    } catch {
      // Ignore DB failure
    }
  }

  public static async regenerateTokenAsync(
    clientId: string,
  ): Promise<ClientSDK | null> {
    await ensureDbSettingsHydrated();
    const existing = await this.getClientAsync(clientId);
    if (!existing) return null;

    const updated: ClientSDK = {
      ...existing,
      secret: `sec_${clientId}_${Math.random().toString(36).substring(2, 10)}`,
      token: AuthService.generateClientToken({
        clientId: existing.clientId,
        name: existing.name,
        rateLimit: existing.rateLimit,
      }),
    };

    getClientsMap().set(clientId, updated);
    await this.persistClientCredentials(updated);
    await notifyIngestionClientSyncAsync(clientId, "updated", updated);
    return updated;
  }

  public static updateClient(
    clientId: string,
    updates: Partial<Pick<ClientSDK, "name" | "rateLimit" | "status">>,
  ): ClientSDK | null {
    const client = getClientsMap().get(clientId);
    if (!client) return null;

    const updated: ClientSDK = {
      ...client,
      ...(updates.name !== undefined ? { name: updates.name.trim() } : {}),
      ...(updates.rateLimit !== undefined
        ? { rateLimit: Math.max(1, Number(updates.rateLimit) || 100) }
        : {}),
      ...(updates.status !== undefined ? { status: updates.status } : {}),
    };

    getClientsMap().set(clientId, updated);
    void this.persistClientUpdates(updated);
    notifyIngestionClientSync(
      clientId,
      updated.status === "revoked" ? "revoked" : "updated",
      updated,
    );
    return updated;
  }

  private static async persistClientUpdates(client: ClientSDK): Promise<void> {
    const pool = DatabaseEngine.getPool();
    if (!pool) return;

    try {
      await DatabaseEngine.ensureSchema();
      await pool.query(
        `UPDATE client_sdks
         SET name = $2, rate_limit = $3, status = $4, updated_at = NOW()
         WHERE client_id = $1`,
        [client.clientId, client.name, client.rateLimit, client.status],
      );
    } catch {
      // Ignore DB failure
    }
  }

  public static async updateClientAsync(
    clientId: string,
    updates: Partial<Pick<ClientSDK, "name" | "rateLimit" | "status">>,
  ): Promise<ClientSDK | null> {
    await ensureDbSettingsHydrated();
    const client = await this.getClientAsync(clientId);
    if (!client) return null;

    const updated: ClientSDK = {
      ...client,
      ...(updates.name !== undefined ? { name: updates.name.trim() } : {}),
      ...(updates.rateLimit !== undefined
        ? { rateLimit: Math.max(1, Number(updates.rateLimit) || 100) }
        : {}),
      ...(updates.status !== undefined ? { status: updates.status } : {}),
    };

    getClientsMap().set(clientId, updated);
    await this.persistClientUpdates(updated);
    await notifyIngestionClientSyncAsync(
      clientId,
      updated.status === "revoked" ? "revoked" : "updated",
      updated,
    );
    return updated;
  }

  public static isClientDeleted(clientId: string): boolean {
    const normalized = String(clientId || "")
      .trim()
      .toLowerCase();
    return getDeletedClientsSet().has(normalized);
  }

  public static async isClientDeletedAsync(clientId: string): Promise<boolean> {
    const normalized = String(clientId || "")
      .trim()
      .toLowerCase();
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
    const normalized = String(clientId || "")
      .trim()
      .toLowerCase();
    const deleted = getClientsMap().delete(normalized);
    getSyncedSocketEventsMap().delete(normalized);
    if (deleted) {
      getDeletedClientsSet().add(normalized);
    }
    void this.deleteClientFromDb(normalized);
    notifyIngestionClientSync(normalized, "deleted");
    return deleted;
  }

  private static async deleteClientFromDb(clientId: string): Promise<boolean> {
    const pool = DatabaseEngine.getPool();
    if (!pool) return false;

    await DatabaseEngine.ensureSchema();
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
    } catch {
      await dbClient.query("ROLLBACK").catch(() => undefined);
      return false;
    } finally {
      dbClient.release();
    }
  }

  private static purgeClientStorageDir(clientId: string): void {
    const safeId = clientId.replace(/[^a-z0-9_-]/gi, "_");
    if (!safeId) return;
    const storageRoot = resolve(process.cwd(), "storage", "data");
    const targetDir = resolve(storageRoot, safeId);
    if (!targetDir.startsWith(`${storageRoot}${sep}`)) return;
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
  }

  public static async deleteClientAsync(
    clientId: string,
    options?: { purgeFiles?: boolean },
  ): Promise<boolean> {
    await ensureDbSettingsHydrated();
    const normalized = String(clientId || "")
      .trim()
      .toLowerCase();
    const existedInMem = getClientsMap().delete(normalized);
    getSyncedSocketEventsMap().delete(normalized);
    const deletedFromDb = await this.deleteClientFromDb(normalized);
    if (existedInMem || deletedFromDb) {
      getDeletedClientsSet().add(normalized);
      if (options?.purgeFiles) {
        this.purgeClientStorageDir(normalized);
      }
      await notifyIngestionClientSyncAsync(normalized, "deleted");
    }
    return existedInMem || deletedFromDb;
  }

  public static incrementEventCount(clientId: string, count = 1): void {
    const nowIso = new Date().toISOString();
    const client = getClientsMap().get(clientId);
    if (client) {
      client.totalEvents += count;
      client.lastActive = nowIso;
      getClientsMap().set(clientId, client);
    }

    const pool = DatabaseEngine.getPool();
    if (pool) {
      void DatabaseEngine.ensureSchema()
        .then(() =>
          pool.query(
            `UPDATE client_sdks
             SET total_events = total_events + $2,
                 last_active = $3,
                 updated_at = NOW()
             WHERE client_id = $1`,
            [clientId, count, nowIso],
          ),
        )
        .catch(() => undefined);
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
      void this.persistClientCredentials(client);
    }
  }

  public static async resignAllClientTokensAsync(): Promise<void> {
    const clients = await this.listClientsAsync();
    const map = getClientsMap();
    for (const client of clients) {
      client.token = AuthService.generateClientToken({
        clientId: client.clientId,
        name: client.name,
        rateLimit: client.rateLimit,
      });
      map.set(client.clientId, client);
      await this.persistClientCredentials(client);
    }
  }
}

export default SDKManager;
