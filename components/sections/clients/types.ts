export interface ClientItem {
  clientId: string;
  name: string;
  rateLimit: number;
  storageQuotaMb?: number;
  allowedIps?: string;
  expiresAt?: string | null;
  status: "active" | "revoked";
  totalEvents: number;
  lastActive?: string;
  createdAt: string;
  tokenPreview?: string;
}

export interface ClientCredentials extends ClientItem {
  secret: string;
  token: string;
}

export type ClientStatusFilter =
  | "all"
  | "online"
  | "offline"
  | "pending"
  | "revoked";
