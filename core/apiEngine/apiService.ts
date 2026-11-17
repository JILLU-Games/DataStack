import { SDKManager } from '../sdk/sdkManager';
import { CSVStorageManager } from '../Storage/csvStorage';
import { DataBufferEngine } from '../data/buffer';
import { SecurityEngine } from '../Security/security';

export class ApiEngine {
  /**
   * Retrieves overall telemetry and health metrics for the dashboard
   */
  public static async getDashboardMetrics() {
    const storageStats = CSVStorageManager.getStorageStats();
    const localBufferStats = DataBufferEngine.getBufferStats();
    const clients = await SDKManager.listClientsAsync();
    const activeClients = clients.filter((c) => c.status === 'active').length;
    let activeSockets = 0;
    let ingestionBufferSize = 0;

    const ingestionBaseUrl = (
      process.env.INGESTION_INTERNAL_URL || 'http://127.0.0.1:4000'
    ).replace(/\/$/, '');

    try {
      const res = await fetch(`${ingestionBaseUrl}/health`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        activeSockets = Number(data.activeSockets) || 0;
        ingestionBufferSize = Number(data.bufferSize) || 0;
      }
    } catch {
      // Ingestion server may not be running in single-process dev mode
      activeSockets = 0;
      ingestionBufferSize = 0;
    }

    const securityStats = SecurityEngine.getStats();
    const bufferStats = {
      ...localBufferStats,
      currentBufferSize:
        localBufferStats.currentBufferSize + ingestionBufferSize,
    };

    return {
      activeSockets,
      totalClients: clients.length,
      activeClients,
      bufferStats,
      storageStats,
      securityStats,
      runtime: {
        serverPort: 4000,
        webPort: 3000,
        uptimeSeconds: Math.floor(process.uptime()),
        memoryUsageMb: (process.memoryUsage().rss / (1024 * 1024)).toFixed(1),
        nodeVersion: process.version,
      },
    };
  }

  /**
   * Filters and streams stored CSV data for export
   */
  public static getExportFiles(clientId?: string) {
    const allFiles = CSVStorageManager.listAllFiles();
    if (clientId && clientId !== 'all') {
      return allFiles.filter((f) => f.clientId === clientId);
    }
    return allFiles;
  }
}

export default ApiEngine;
