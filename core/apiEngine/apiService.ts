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

    try {
      const res = await fetch(`${ingestionBaseUrl}/internal/metrics`, {
        headers: internalHeaders,
        cache: 'no-store',
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        const data = await res.json();
        activeSockets = Number(data.activeSockets) || 0;
        ingestionRedisConnected = Boolean(data.redisConnected);
        if (data.localBufferSize !== undefined) {
          ingestionLocalBufferSize = Number(data.localBufferSize) || 0;
          ingestionRedisBufferSize = Number(data.redisBufferSize) || 0;
        } else {
          ingestionLocalBufferSize = Number(data.bufferSize) || 0;
        }
        if (data.securityStats && typeof data.securityStats === 'object') {
          remoteSecurityStats = data.securityStats;
        }
      }
    } catch {
      // Ingestion server may not be running in single-process dev mode
      activeSockets = 0;
      ingestionLocalBufferSize = 0;
      ingestionRedisBufferSize = 0;
    }

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
    };

    const effectiveRedisBufferSize = Math.max(
      localBufferStats.redisBufferSize || 0,
      ingestionRedisBufferSize,
    );
    const bufferStats = {
      ...localBufferStats,
      redisConnected: localBufferStats.redisConnected || ingestionRedisConnected,
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
        serverPort: settings.serverPort || 4000,
        webPort: settings.webPort || 3000,
        uptimeSeconds: Math.floor(process.uptime()),
        memoryUsageMb: (process.memoryUsage().rss / (1024 * 1024)).toFixed(1),
        nodeVersion: process.version,
      },
    };
  }

  /**
   * Filters and lists stored CSV files for export
   */
  public static getExportFiles(clientId?: string) {
    const allFiles = CSVStorageManager.listAllFiles();
    if (clientId && clientId !== 'all') {
      return allFiles.filter((f) => f.clientId === clientId);
    }
    return allFiles;
  }

  public static async getExportFilesAsync(clientId?: string) {
    const allFiles = await CSVStorageManager.listAllFilesAsync();
    if (clientId && clientId !== 'all') {
      return allFiles.filter((f) => f.clientId === clientId);
    }
    return allFiles;
  }
}

export default ApiEngine;
