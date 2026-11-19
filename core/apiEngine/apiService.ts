import { SettingsManager } from '../adminSettings/settingsManager';
import { SDKManager } from '../sdk/sdkManager';
import { CSVStorageManager } from '../Storage/csvStorage';
import { DataBufferEngine } from '../data/buffer';
import {
  SecurityEngine,
  getInternalIngestionHeaders,
} from '../Security/security';

export class ApiEngine {
  /**
   * Retrieves overall telemetry and health metrics for the dashboard
   */
  public static async getDashboardMetrics() {
    const settings = await SettingsManager.getSettingsAsync();
    const [storageStats, localBufferStats, clients] = await Promise.all([
      CSVStorageManager.getStorageStatsAsync(),
      DataBufferEngine.getBufferStatsAsync(),
      SDKManager.listClientsAsync(),
    ]);
    const activeClients = clients.filter((c) => c.status === 'active').length;
    let activeSockets = 0;
    let ingestionLocalBufferSize = 0;
    let ingestionRedisBufferSize = 0;
    let ingestionRedisConnected = false;
    let remoteSecurityStats: {
      activeIdempotencyKeys?: number;
      rateLimitedClientsCount?: number;
      maxPayloadSizeBytes?: number;
    } | null = null;

    const ingestionBaseUrl = (
      process.env.INGESTION_INTERNAL_URL || 'http://127.0.0.1:4000'
    ).replace(/\/$/, '');
    const internalHeaders = getInternalIngestionHeaders();

    let ingestionBridgeStatus: 'online' | 'auth_error' | 'error' | 'offline' = 'offline';
    let ingestionBridgeError: string | undefined;
    let liveServerPort = settings.serverPort || 4000;
    let liveWebPort = settings.webPort || 3000;

    try {
      const res = await fetch(`${ingestionBaseUrl}/internal/metrics`, {
        headers: internalHeaders,
        cache: 'no-store',
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        const data = await res.json();
        ingestionBridgeStatus = 'online';
        activeSockets = Number(data.activeSockets) || 0;
        ingestionRedisConnected = Boolean(data.redisConnected);
        if (Number.isFinite(Number(data.serverPort)) && Number(data.serverPort) > 0) {
          liveServerPort = Number(data.serverPort);
        } else if (Number.isFinite(Number(data.port)) && Number(data.port) > 0) {
          liveServerPort = Number(data.port);
        }
        if (Number.isFinite(Number(data.webPort)) && Number(data.webPort) > 0) {
          liveWebPort = Number(data.webPort);
        }
        if (data.localBufferSize !== undefined) {
          ingestionLocalBufferSize = Number(data.localBufferSize) || 0;
          ingestionRedisBufferSize = Number(data.redisBufferSize) || 0;
        } else {
          ingestionLocalBufferSize = Number(data.bufferSize) || 0;
        }
        if (data.securityStats && typeof data.securityStats === 'object') {
          remoteSecurityStats = data.securityStats;
        }
        // BUG-02: Auto-reconcile Port 4000 cold start whenever metrics observe unsynced registry
        if (data.hasSyncedInMemoryClients === false && clients.length > 0) {
          await SDKManager.syncAllClientsToIngestionAsync();
        }
      } else {
        ingestionBridgeStatus = res.status === 401 || res.status === 503 ? 'auth_error' : 'error';
        ingestionBridgeError = `HTTP ${res.status}`;
        console.warn(`[DataStack Bridge] /internal/metrics failed with ${ingestionBridgeError}`);
      }
    } catch (err: unknown) {
      // Ingestion server may not be running in single-process dev mode
      activeSockets = 0;
      ingestionLocalBufferSize = 0;
      ingestionRedisBufferSize = 0;
      ingestionBridgeStatus = 'offline';
      ingestionBridgeError = err instanceof Error ? err.message : 'Unreachable';
    }

    const effectiveRedisBufferSize = Math.max(
      localBufferStats.redisBufferSize || 0,
      ingestionRedisBufferSize,
    );
    const redisConnected = localBufferStats.redisConnected || ingestionRedisConnected;
    const securityMode: 'redis_shared' | 'bridge_coordinated' | 'degraded_local' =
      redisConnected
        ? 'redis_shared'
        : ingestionBridgeStatus === 'online'
          ? 'bridge_coordinated'
          : 'degraded_local';

    const localSecurityStats = SecurityEngine.getStats();
    const securityStats = {
      activeIdempotencyKeys:
        localSecurityStats.activeIdempotencyKeys +
        (Number(remoteSecurityStats?.activeIdempotencyKeys) || 0),
      rateLimitedClientsCount:
        localSecurityStats.rateLimitedClientsCount +
        (Number(remoteSecurityStats?.rateLimitedClientsCount) || 0),
      maxPayloadSizeBytes: Math.min(
        localSecurityStats.maxPayloadSizeBytes,
        Number(remoteSecurityStats?.maxPayloadSizeBytes) ||
          localSecurityStats.maxPayloadSizeBytes,
      ),
      mode: securityMode,
    };

    const bufferStats = {
      ...localBufferStats,
      redisConnected,
      redisBufferSize: effectiveRedisBufferSize,
      currentBufferSize:
        localBufferStats.localBufferSize +
        ingestionLocalBufferSize +
        effectiveRedisBufferSize,
    };

    return {
      activeSockets,
      totalClients: clients.length,
      activeClients,
      bufferStats,
      storageStats,
      securityStats,
      runtime: {
        serverPort: liveServerPort,
        webPort: liveWebPort,
        ingestionBridgeStatus,
        ...(ingestionBridgeError ? { ingestionBridgeError } : {}),
        securityMode,
        uptimeSeconds: Math.floor(process.uptime()),
        memoryUsageMb: (process.memoryUsage().rss / (1024 * 1024)).toFixed(1),
        nodeVersion: process.version,
      },
    };
  }

  private static filterFilesByClientId<T extends { clientId: string }>(
    files: T[],
    clientId?: string,
  ): T[] {
    if (!clientId || clientId === 'all') return files;
    const normalized = SDKManager.normalizeClientId(clientId);
    if (!normalized) return files;
    const sanitized = CSVStorageManager.sanitizeClientId(normalized);
    return files.filter((f) => {
      const folderNorm = SDKManager.normalizeClientId(f.clientId);
      return (
        folderNorm === normalized ||
        f.clientId === normalized ||
        f.clientId === sanitized
      );
    });
  }

  /**
   * Filters and lists stored CSV files for export
   */
  public static getExportFiles(clientId?: string) {
    const allFiles = CSVStorageManager.listAllFiles();
    return this.filterFilesByClientId(allFiles, clientId);
  }

  public static async getExportFilesAsync(clientId?: string) {
    const allFiles = await CSVStorageManager.listAllFilesAsync();
    return this.filterFilesByClientId(allFiles, clientId);
  }
}

export default ApiEngine;
