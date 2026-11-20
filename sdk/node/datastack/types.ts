export type DataStackTransportMode = 'websocket' | 'http' | 'spool';

export type DataStackConnectionState =
  | 'IDLE_WS'
  | 'HTTP_FALLBACK'
  | 'OFFLINE_SPOOL'
  | 'DISCONNECTED';

export type DataStackEventPayload = Record<string, unknown>;

export interface DataStackConfigOptions {
  /** Port 4000 Socket.IO ingestion server URL (e.g. http://localhost:4000) */
  serverUrl?: string;
  /** Port 3000 Next.js HTTP API URL (e.g. http://localhost:3000) */
  apiUrl?: string;
  /** Signed client JWT token issued from /vcon/clients */
  token?: string;
  /** Alias for token */
  clientToken?: string;
  /** Expected normalized clientId (validated against token subject if both present) */
  clientId?: string;
  /** Optional path to datastack.config.json */
  configPath?: string;
  /** Automatically connect WebSocket on instantiation (default: false in Node tests, true when configured) */
  autoConnect?: boolean;
  /** Fall back to HTTP POST /api/events when WebSocket is disconnected (default: true) */
  enableHttpFallback?: boolean;
  /** Background heartbeat recovery interval in milliseconds (default: 5000) */
  heartbeatIntervalMs?: number;
  /** Maximum retry attempts for transient or 429 rate-limited chunks (default: 3) */
  maxRetries?: number;
  /** Maximum records per batch chunk (default: 250, max: 1000) */
  batchChunkSize?: number;
  /** Enable local disk spooling when both WebSocket and HTTP are unreachable (default: true) */
  offlineSpoolEnabled?: boolean;
  /** Directory path for offline spool JSONL file (default: ".datastack_spool") */
  offlineSpoolDir?: string;
  /** Maximum offline spool file size in megabytes (default: 50) */
  maxSpoolSizeMb?: number;
  /** Per-request timeout in milliseconds for WebSocket ACKs and HTTP requests (default: 5000) */
  requestTimeoutMs?: number;
  /** Custom fetch implementation for testing or custom agents */
  fetchImpl?: typeof fetch;
}

export interface ResolvedDataStackConfig {
  serverUrl: string;
  apiUrl: string;
  clientToken: string;
  clientId: string;
  autoConnect: boolean;
  enableHttpFallback: boolean;
  heartbeatIntervalMs: number;
  maxRetries: number;
  batchChunkSize: number;
  offlineSpoolEnabled: boolean;
  offlineSpoolDir: string;
  maxSpoolSizeMb: number;
  requestTimeoutMs: number;
}

export interface DataStackEnvelope {
  clientId: string;
  eventId: string;
  timestamp: string;
  data: DataStackEventPayload;
}

export interface DataStackSendResult {
  success: boolean;
  transport: DataStackTransportMode;
  eventId?: string;
  accepted?: number;
  spooled?: number;
  duplicates?: number;
  code?: string;
  error?: string;
  rateLimitedEventIds?: string[];
  unprocessedItems?: DataStackEventPayload[];
}

export interface DataStackFileSendResult extends DataStackSendResult {
  filePath: string;
  totalRows: number;
  acceptedRows: number;
  spooledRows: number;
  chunksSent: number;
}

export interface DataStackStatusSnapshot {
  connected: boolean;
  transportState: DataStackConnectionState;
  clientId: string;
  serverUrl: string;
  apiUrl: string;
  spooledCount: number;
  spooledBytes: number;
  inFlightRequests: number;
}

/**
 * Base error class for all DataStack Node.js / TypeScript SDK errors (V2-E12).
 */
export class DataStackError extends Error {
  public readonly code: string;
  public readonly statusCode?: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code = 'DATASTACK_ERROR',
    statusCode?: number,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'DataStackError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class DataStackConfigError extends DataStackError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'INVALID_SDK_CONFIG', 400, details);
    this.name = 'DataStackConfigError';
  }
}

export class DataStackAuthError extends DataStackError {
  constructor(
    message: string,
    code:
      | 'AUTH_FAILED'
      | 'CLIENT_TOKEN_EXPIRED'
      | 'CLIENT_IP_FORBIDDEN'
      | 'CLIENT_REVOKED' = 'AUTH_FAILED',
    statusCode = 401,
    details?: Record<string, unknown>
  ) {
    super(message, code, statusCode, details);
    this.name = 'DataStackAuthError';
  }
}

export class DataStackRateLimitError extends DataStackError {
  public readonly rateLimitedEventIds: string[];

  constructor(
    message: string,
    rateLimitedEventIds: string[] = [],
    details?: Record<string, unknown>
  ) {
    super(message, 'RATE_LIMIT_EXCEEDED', 429, details);
    this.name = 'DataStackRateLimitError';
    this.rateLimitedEventIds = rateLimitedEventIds;
  }
}

export class DataStackQuotaExceededError extends DataStackError {
  constructor(
    message: string,
    code: 'STORAGE_QUOTA_EXCEEDED' | 'DISK_SPACE_LOW' = 'STORAGE_QUOTA_EXCEEDED',
    details?: Record<string, unknown>
  ) {
    super(message, code, 507, details);
    this.name = 'DataStackQuotaExceededError';
  }
}

export class DataStackPayloadTooLargeError extends DataStackError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'PAYLOAD_TOO_LARGE', 413, details);
    this.name = 'DataStackPayloadTooLargeError';
  }
}

export class DataStackFileError extends DataStackError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'FILE_INGESTION_ERROR', 400, details);
    this.name = 'DataStackFileError';
  }
}

export class DataStackShutdownTimeoutError extends DataStackError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'SHUTDOWN_FLUSH_TIMEOUT', 408, details);
    this.name = 'DataStackShutdownTimeoutError';
  }
}
