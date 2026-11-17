import { AuthService } from "../auth/jwt";
import { DatabaseEngine } from "../Database/database";

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
  __dataStackClientsHydrated?: boolean;
};

const globals = globalThis as SDKDatabaseGlobals;

function getClientsMap(): Map<string, ClientSDK> {
  if (!globals.__dataStackClientsMap) {
    globals.__dataStackClientsMap = new Map<string, ClientSDK>();
  }
  return globals.__dataStackClientsMap;
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

      const result = await pool.query(
        `SELECT client_id, name, secret, token, rate_limit, status, total_events, last_active, created_at
         FROM client_sdks
         ORDER BY created_at DESC`,
      );

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

  public static async listClientsAsync(): Promise<ClientSDK[]> {
    const fromDb = await this.syncFromDatabase();
    if (fromDb !== null) {
      return fromDb;
    }
    return Array.from(getClientsMap().values());
  }

  public static getClient(clientId: string): ClientSDK | undefined {
    return getClientsMap().get(clientId);
  }

  public static async getClientAsync(
    clientId: string,
  ): Promise<ClientSDK | undefined> {
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

    getClientsMap().set(safeClientId, newClient);
    void this.persistNewClient(newClient);
    return newClient;
  }

  private static async persistNewClient(client: ClientSDK): Promise<void> {
    const pool = DatabaseEngine.getPool();
    if (!pool) return;

    try {
      await DatabaseEngine.ensureSchema();
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

    getClientsMap().set(safeClientId, newClient);
    await this.persistNewClient(newClient);
    return newClient;
  }

  public static regenerateToken(clientId: string): ClientSDK | null {
    const client = getClientsMap().get(clientId);
    if (!client) return null;

    client.secret = `sec_${clientId}_${Math.random().toString(36).substring(2, 10)}`;
    client.token = AuthService.generateClientToken({
      clientId: client.clientId,
      name: client.name,
      rateLimit: client.rateLimit,
    });

    getClientsMap().set(clientId, client);
    void this.persistClientCredentials(client);
    return client;
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
    const existing = await this.getClientAsync(clientId);
    if (!existing) return null;

    existing.secret = `sec_${clientId}_${Math.random().toString(36).substring(2, 10)}`;
    existing.token = AuthService.generateClientToken({
      clientId: existing.clientId,
      name: existing.name,
      rateLimit: existing.rateLimit,
    });

    getClientsMap().set(clientId, existing);
    await this.persistClientCredentials(existing);
    return existing;
  }

  public static updateClient(
    clientId: string,
    updates: Partial<Pick<ClientSDK, "name" | "rateLimit" | "status">>,
  ): ClientSDK | null {
    const client = getClientsMap().get(clientId);
    if (!client) return null;

    if (updates.name !== undefined) client.name = updates.name.trim();
    if (updates.rateLimit !== undefined)
      client.rateLimit = Math.max(1, Number(updates.rateLimit) || 100);
    if (updates.status !== undefined) client.status = updates.status;

    getClientsMap().set(clientId, client);
    void this.persistClientUpdates(client);
    return client;
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
    const client = await this.getClientAsync(clientId);
    if (!client) return null;

    if (updates.name !== undefined) client.name = updates.name.trim();
    if (updates.rateLimit !== undefined)
      client.rateLimit = Math.max(1, Number(updates.rateLimit) || 100);
    if (updates.status !== undefined) client.status = updates.status;

    getClientsMap().set(clientId, client);
    await this.persistClientUpdates(client);
    return client;
  }

  public static deleteClient(clientId: string): boolean {
    const deleted = getClientsMap().delete(clientId);
    void this.deleteClientFromDb(clientId);
    return deleted;
  }

  private static async deleteClientFromDb(clientId: string): Promise<boolean> {
    const pool = DatabaseEngine.getPool();
    if (!pool) return false;

    try {
      await DatabaseEngine.ensureSchema();
      const res = await pool.query(
        `DELETE FROM client_sdks WHERE client_id = $1`,
        [clientId],
      );
      return Boolean(res.rowCount && res.rowCount > 0);
    } catch {
      return false;
    }
  }

  public static async deleteClientAsync(clientId: string): Promise<boolean> {
    const existedInMem = getClientsMap().delete(clientId);
    const deletedFromDb = await this.deleteClientFromDb(clientId);
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
