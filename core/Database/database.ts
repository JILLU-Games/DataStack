import { SettingsManager } from "../adminSettings/settingsManager";
import { SDKManager } from "../sdk/sdkManager";

/**
 * Database Module (PostgreSQL + Prisma abstraction)
 * CRITICAL RULE: PostgreSQL stores strictly administrative metadata,
 * client registrations, and configuration. Collected data is NEVER stored in PostgreSQL.
 */
export class DatabaseEngine {
  public static isConnected = true;

  public static async getHealth() {
    return {
      status: "healthy",
      type: "PostgreSQL + Prisma Schema Managed",
      database: "datastack_db",
      role: "Metadata & SDK Registrations Only",
      collectedDataStorage: "Strictly CSV (/storage/data)",
    };
  }

  public static async syncState() {
    return {
      clientsCount: SDKManager.listClients().length,
      settings: SettingsManager.getPublicSettings(),
    };
  }
}

export default DatabaseEngine;
