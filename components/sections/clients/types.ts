export interface ClientItem {
  clientId: string;
  name: string;
  rateLimit: number;
  status: "active" | "revoked";
  totalEvents: number;
  lastActive?: string;
  createdAt: string;
}

export interface ClientCredentials extends ClientItem {
  secret: string;
  token: string;
}

export type ClientStatusFilter = "all" | "online" | "offline" | "pending";
