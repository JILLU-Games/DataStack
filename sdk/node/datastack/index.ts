import { parse as parseCsvSync } from 'csv-parse/sync';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { DiskSpooler, type DiskSpoolerOptions } from './spool';
import {
  DataStackAuthError,
  DataStackConfigError,
  DataStackError,
  DataStackFileError,
  DataStackPayloadTooLargeError,
  DataStackQuotaExceededError,
  DataStackRateLimitError,
  DataStackShutdownTimeoutError,
  type DataStackAuthErrorCode,
  type DataStackConfigOptions,
  type DataStackConnectionState,
  type DataStackEnvelope,
  type DataStackEventPayload,
  type DataStackFileSendResult,
  type DataStackSendResult,
  type DataStackStatusSnapshot,
  type DataStackTransportMode,
  type ResolvedDataStackConfig,
} from './types';

export {
  DiskSpooler,
  DataStackAuthError,
  DataStackConfigError,
  DataStackError,
  DataStackFileError,
  DataStackPayloadTooLargeError,
  DataStackQuotaExceededError,
  DataStackRateLimitError,
  DataStackShutdownTimeoutError,
  type DiskSpoolerOptions,
  type DataStackAuthErrorCode,
  type DataStackConfigOptions,
  type DataStackConnectionState,
  type DataStackEnvelope,
  type DataStackEventPayload,
  type DataStackFileSendResult,
  type DataStackSendResult,
  type DataStackStatusSnapshot,
  type DataStackTransportMode,
  type ResolvedDataStackConfig,
};

export const SDK_VERSION = '2.2.0';

function classifyAuthRejection(
  rawCode: string,
  rawMsg: string
): { code: DataStackAuthErrorCode; statusCode: number } | null {
  const code = String(rawCode || '').toUpperCase();
  const upperMsg = String(rawMsg || '').toUpperCase();
  const combined = `${code} ${upperMsg}`;

  if (combined.includes('CLIENT_TOKEN_EXPIRED')) {
    return { code: 'CLIENT_TOKEN_EXPIRED', statusCode: 401 };
  }
  if (combined.includes('TOKEN_ROTATED')) {
    return { code: 'TOKEN_ROTATED', statusCode: 401 };
  }
  if (combined.includes('CLIENT_IP_FORBIDDEN')) {
    return { code: 'CLIENT_IP_FORBIDDEN', statusCode: 403 };
  }
  if (combined.includes('CLIENT_REVOKED') || upperMsg.includes('REVOKED')) {
    return { code: 'CLIENT_REVOKED', statusCode: 403 };
  }
  if (
    code === 'AUTH_FAILED' ||
    code === 'AUTH_INVALID' ||
    code === 'AUTH_REQUIRED' ||
    upperMsg.includes('AUTHENTICATION') ||
    upperMsg.includes('INVALID TOKEN')
  ) {
    return { code: 'AUTH_FAILED', statusCode: 401 };
  }
  return null;
}

/**
 * Matches server `SDKManager.normalizeClientId()` and Python SDK `_normalize_client_id()`.
 */
export function normalizeClientId(value?: string | null): string {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return '';
  return raw.replace(/[^a-z0-9_-]/g, '_');
}

/**
 * Extracts `clientId` or `sub` claim from an unverified JWT payload string.
 */
export function decodeJwtClientId(token?: string | null): string {
  try {
    const parts = String(token ?? '').split('.');
    if (parts.length !== 3) return '';
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const claims = JSON.parse(json) as Record<string, unknown>;
    if (claims && typeof claims === 'object') {
      return String(claims.clientId || claims.sub || '').trim();
    }
  } catch {
    // Ignore malformed JWT
  }
  return '';
}

export function makeEventId(): string {
  return `evt_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Generates a deterministic SHA-256 `eventId` for file rows (1:1 parity with Python SDK)
 * so re-ingesting the same `.csv`, `.json`, or `.jsonl` file is idempotently deduplicated.
 */
export function makeDeterministicFileEventId(
  fileStem: string,
  rowIndex: number,
  record: DataStackEventPayload
): string {
  const sortedKeys = Object.keys(record).sort();
  const canonicalObj: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    canonicalObj[key] = record[key];
  }
  const raw = `${fileStem}:${rowIndex}:${JSON.stringify(canonicalObj)}`;
  const digest = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12);
  const safeStem = fileStem.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  return `file_${safeStem}_${rowIndex}_${digest}`;
}

function loadJsonConfigFile(configPath?: string): Partial<DataStackConfigOptions> {
  const target = configPath
    ? path.resolve(configPath)
    : path.resolve(process.cwd(), 'datastack.config.json');
  if (!fs.existsSync(target)) {
    if (configPath) {
      throw new DataStackConfigError(`Configuration file not found: ${target}`);
    }
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
    return {
      serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : typeof parsed.SERVER_URL === 'string' ? parsed.SERVER_URL : undefined,
      apiUrl: typeof parsed.apiUrl === 'string' ? parsed.apiUrl : typeof parsed.API_URL === 'string' ? parsed.API_URL : undefined,
      clientToken: typeof parsed.clientToken === 'string' ? parsed.clientToken : typeof parsed.CLIENT_TOKEN === 'string' ? parsed.CLIENT_TOKEN : typeof parsed.token === 'string' ? parsed.token : undefined,
      clientId: typeof parsed.clientId === 'string' ? parsed.clientId : typeof parsed.CLIENT_ID === 'string' ? parsed.CLIENT_ID : undefined,
      autoConnect: typeof parsed.autoConnect === 'boolean' ? parsed.autoConnect : typeof parsed.AUTO_CONNECT === 'boolean' ? parsed.AUTO_CONNECT : undefined,
      enableHttpFallback: typeof parsed.enableHttpFallback === 'boolean' ? parsed.enableHttpFallback : typeof parsed.ENABLE_HTTP_FALLBACK === 'boolean' ? parsed.ENABLE_HTTP_FALLBACK : undefined,
      heartbeatIntervalMs: typeof parsed.heartbeatIntervalMs === 'number' ? parsed.heartbeatIntervalMs : undefined,
      maxRetries: typeof parsed.maxRetries === 'number' ? parsed.maxRetries : typeof parsed.MAX_RETRIES === 'number' ? parsed.MAX_RETRIES : undefined,
      batchChunkSize: typeof parsed.batchChunkSize === 'number' ? parsed.batchChunkSize : typeof parsed.BATCH_CHUNK_SIZE === 'number' ? parsed.BATCH_CHUNK_SIZE : undefined,
      offlineSpoolEnabled: typeof parsed.offlineSpoolEnabled === 'boolean' ? parsed.offlineSpoolEnabled : typeof parsed.OFFLINE_SPOOL_ENABLED === 'boolean' ? parsed.OFFLINE_SPOOL_ENABLED : undefined,
      offlineSpoolDir: typeof parsed.offlineSpoolDir === 'string' ? parsed.offlineSpoolDir : typeof parsed.OFFLINE_SPOOL_DIR === 'string' ? parsed.OFFLINE_SPOOL_DIR : undefined,
      maxSpoolSizeMb: typeof parsed.maxSpoolSizeMb === 'number' ? parsed.maxSpoolSizeMb : undefined,
      requestTimeoutMs: typeof parsed.requestTimeoutMs === 'number' ? parsed.requestTimeoutMs : undefined,
    };
  } catch (err) {
    throw new DataStackConfigError(
      `Failed to parse datastack.config.json (${target}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export class DataStackClient {
  public readonly config: ResolvedDataStackConfig;
  public readonly clientId: string;
  public readonly spooler: DiskSpooler;
  private socket: Socket | null = null;
  private isConnected = false;
  private transportState: DataStackConnectionState = 'DISCONNECTED';
  private inFlightSet = new Set<Promise<unknown>>();
  private isDrainingSpool = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInFlight = false;
  private heartbeatStopped = false;
  private readonly fetchFn: typeof fetch;

  constructor(options: DataStackConfigOptions = {}) {
    const fileCfg = loadJsonConfigFile(options.configPath);
    const serverUrl = String(
      options.serverUrl ??
        fileCfg.serverUrl ??
        process.env.DATASTACK_SERVER_URL ??
        'http://localhost:4000'
    )
      .trim()
      .replace(/\/+$/, '');
    const apiUrl = String(
      options.apiUrl ??
        fileCfg.apiUrl ??
        process.env.DATASTACK_API_URL ??
        'http://localhost:3000'
    )
      .trim()
      .replace(/\/+$/, '');
    const clientToken = String(
      options.token ??
        options.clientToken ??
        fileCfg.clientToken ??
        process.env.DATASTACK_CLIENT_TOKEN ??
        ''
    ).trim();

    if (!/^https?:\/\//i.test(serverUrl)) {
      throw new DataStackConfigError(
        `Invalid serverUrl '${serverUrl}'. Expected http:// or https:// URL.`
      );
    }
    if (!/^https?:\/\//i.test(apiUrl)) {
      throw new DataStackConfigError(
        `Invalid apiUrl '${apiUrl}'. Expected http:// or https:// URL.`
      );
    }

    const configuredClientId = String(
      options.clientId ??
        fileCfg.clientId ??
        process.env.DATASTACK_CLIENT_ID ??
        ''
    ).trim();
    const tokenClientId = decodeJwtClientId(clientToken);
    const normConfigured = normalizeClientId(configuredClientId);
    const normToken = normalizeClientId(tokenClientId);

    if (normConfigured && normToken && normConfigured !== normToken) {
      throw new DataStackConfigError(
        `Configured clientId '${configuredClientId}' does not match JWT token subject '${tokenClientId}'.`
      );
    }

    const batchChunkSize = Number(
      options.batchChunkSize ?? fileCfg.batchChunkSize ?? 250
    );
    if (!Number.isFinite(batchChunkSize) || batchChunkSize < 1 || batchChunkSize > 1000) {
      throw new DataStackConfigError(
        `Invalid batchChunkSize '${batchChunkSize}'. Must be between 1 and 1000.`
      );
    }

    const maxRetries = Number(options.maxRetries ?? fileCfg.maxRetries ?? 3);
    if (!Number.isFinite(maxRetries) || maxRetries < 0 || maxRetries > 20) {
      throw new DataStackConfigError(
        `Invalid maxRetries '${maxRetries}'. Must be between 0 and 20.`
      );
    }

    const requestTimeoutMs = Number(
      options.requestTimeoutMs ?? fileCfg.requestTimeoutMs ?? 5000
    );
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 100) {
      throw new DataStackConfigError(
        `Invalid requestTimeoutMs '${requestTimeoutMs}'. Must be >= 100ms.`
      );
    }

    const rawHeartbeat = Number(
      options.heartbeatIntervalMs ?? fileCfg.heartbeatIntervalMs ?? 5000
    );
    const heartbeatIntervalMs =
      Number.isFinite(rawHeartbeat) && rawHeartbeat > 0
        ? Math.max(50, Math.floor(rawHeartbeat))
        : 0;

    this.clientId = normToken || normConfigured;
    this.config = {
      serverUrl,
      apiUrl,
      clientToken,
      clientId: this.clientId,
      autoConnect: Boolean(options.autoConnect ?? fileCfg.autoConnect ?? false),
      enableHttpFallback:
        options.enableHttpFallback ?? fileCfg.enableHttpFallback ?? true,
      heartbeatIntervalMs,
      maxRetries,
      batchChunkSize: Math.floor(batchChunkSize),
      offlineSpoolEnabled:
        options.offlineSpoolEnabled ?? fileCfg.offlineSpoolEnabled ?? true,
      offlineSpoolDir: String(
        options.offlineSpoolDir ?? fileCfg.offlineSpoolDir ?? '.datastack_spool'
      ),
      maxSpoolSizeMb: Number(
        options.maxSpoolSizeMb ?? fileCfg.maxSpoolSizeMb ?? 50
      ),
      requestTimeoutMs,
    };

    this.fetchFn = options.fetchImpl ?? globalThis.fetch;
    this.spooler = new DiskSpooler({
      spoolDir: this.config.offlineSpoolDir,
      maxSizeMb: this.config.maxSpoolSizeMb,
      enabled: this.config.offlineSpoolEnabled,
    });

    if (this.config.autoConnect && this.config.clientToken) {
      void this.connect().catch(() => {
        // Defer connection error handling to send/fallback
      });
    }
  }

  private trackInFlight<T>(promise: Promise<T>): Promise<T> {
    this.inFlightSet.add(promise);
    return promise.finally(() => {
      this.inFlightSet.delete(promise);
    });
  }

  private startHeartbeatMonitor(): void {
    if (
      this.heartbeatStopped ||
      this.config.heartbeatIntervalMs <= 0 ||
      this.heartbeatTimer !== null
    ) {
      return;
    }
    const timer = setInterval(() => {
      void this.runHeartbeatStep();
    }, this.config.heartbeatIntervalMs);
    timer.unref?.();
    this.heartbeatTimer = timer;
  }

  private stopHeartbeatMonitor(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Verifies the active WebSocket handshake with Port 4000 via `ping_verify`.
   * Throws `DataStackAuthError` immediately on terminal auth rejections.
   */
  public async pingVerify(timeoutMs?: number): Promise<boolean> {
    if (!this.isConnected || !this.socket || !this.socket.connected) {
      return false;
    }
    const waitMs = Math.max(
      100,
      Math.min(timeoutMs ?? this.config.requestTimeoutMs, 5000)
    );
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => resolve(false), waitMs);
      this.socket!.emit(
        'ping_verify',
        {},
        (ack: Record<string, unknown> | undefined) => {
          clearTimeout(timer);
          if (!ack || typeof ack !== 'object') {
            resolve(false);
            return;
          }
          if (ack.success === true) {
            resolve(ack.status === 'VERIFIED' || ack.status === undefined);
            return;
          }
          const code = String(ack.code || '');
          const msg = String(ack.error || 'Handshake verification failed');
          const authErr = classifyAuthRejection(code, msg);
          if (authErr) {
            this.heartbeatStopped = true;
            this.stopHeartbeatMonitor();
            reject(
              new DataStackAuthError(msg, authErr.code, authErr.statusCode, ack)
            );
            return;
          }
          resolve(false);
        }
      );
    });
  }

  /**
   * Executes one zero-CPU IDLE / active recovery heartbeat step:
   * - If WebSocket is already connected (`IDLE_WS`), stops the active recovery timer and returns `true`.
   * - If disconnected/fallback, attempts WS reconnection + `ping_verify` verification, drains spool,
   *   and returns to zero-CPU `IDLE_WS` upon recovery.
   */
  public async runHeartbeatStep(): Promise<boolean> {
    if (this.heartbeatStopped || this.heartbeatInFlight) {
      return false;
    }
    if (this.isConnected && this.socket?.connected) {
      this.transportState = 'IDLE_WS';
      this.stopHeartbeatMonitor();
      return true;
    }

    this.heartbeatInFlight = true;
    try {
      const reconnected = await this.connect();
      if (!reconnected) {
        return false;
      }
      const verified = await this.pingVerify();
      if (!verified) {
        if (this.socket) {
          this.socket.removeAllListeners();
          this.socket.disconnect();
          this.socket = null;
        }
        this.isConnected = false;
        this.transportState = this.config.enableHttpFallback
          ? 'HTTP_FALLBACK'
          : 'DISCONNECTED';
        this.startHeartbeatMonitor();
        return false;
      }
      this.transportState = 'IDLE_WS';
      this.stopHeartbeatMonitor();
      if (this.spooler.count() > 0) {
        void this.flushSpool().catch(() => {});
      }
      return true;
    } catch (err) {
      if (err instanceof DataStackAuthError) {
        this.heartbeatStopped = true;
        this.stopHeartbeatMonitor();
      }
      return false;
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  /**
   * Establishes a real-time Socket.IO connection to Port 4000 (`serverUrl`).
   */
  public async connect(): Promise<boolean> {
    if (!this.config.clientToken) {
      throw new DataStackConfigError(
        'Cannot connect: clientToken is required.'
      );
    }
    this.heartbeatStopped = false;
    if (this.isConnected && this.socket?.connected) {
      this.stopHeartbeatMonitor();
      return true;
    }

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }

    return new Promise<boolean>((resolve, reject) => {
      const sock = io(this.config.serverUrl, {
        auth: {
          token: this.config.clientToken,
          clientId: this.clientId || undefined,
        },
        transports: ['websocket', 'polling'],
        reconnection: false,
        timeout: this.config.requestTimeoutMs,
      });

      this.socket = sock;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sock.disconnect();
        this.isConnected = false;
        this.transportState = this.config.enableHttpFallback
          ? 'HTTP_FALLBACK'
          : 'DISCONNECTED';
        this.startHeartbeatMonitor();
        resolve(false);
      }, this.config.requestTimeoutMs);

      sock.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.isConnected = true;
        this.transportState = 'IDLE_WS';
        this.stopHeartbeatMonitor();
        void this.flushSpool().catch(() => {});
        resolve(true);
      });

      sock.once('connect_error', (err: Error & { data?: Record<string, unknown> }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.isConnected = false;
        sock.disconnect();

        const msg = String(err?.message || '');
        const code = String(err?.data?.code || '');
        const authErr = classifyAuthRejection(code, msg);
        if (authErr) {
          this.heartbeatStopped = true;
          this.stopHeartbeatMonitor();
          reject(
            new DataStackAuthError(
              msg || 'Socket authentication failed.',
              authErr.code,
              authErr.statusCode,
              err?.data
            )
          );
          return;
        }

        this.transportState = this.config.enableHttpFallback
          ? 'HTTP_FALLBACK'
          : 'DISCONNECTED';
        this.startHeartbeatMonitor();
        resolve(false);
      });

      sock.on('disconnect', () => {
        this.isConnected = false;
        if (this.transportState === 'IDLE_WS') {
          this.transportState = this.config.enableHttpFallback
            ? 'HTTP_FALLBACK'
            : 'DISCONNECTED';
        }
        if (!this.heartbeatStopped) {
          this.startHeartbeatMonitor();
        }
      });
    });
  }

  public disconnect(): void {
    this.heartbeatStopped = true;
    this.stopHeartbeatMonitor();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.isConnected = false;
    this.transportState = 'DISCONNECTED';
  }

  private normalizeSingleEnvelope(
    payload: DataStackEventPayload,
    explicitEventId?: string,
    explicitTimestamp?: string
  ): DataStackEnvelope {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new DataStackConfigError(
        'Event payload must be a non-null plain object.'
      );
    }

    const rawCopy: Record<string, unknown> = { ...payload };
    const eventId = String(
      explicitEventId ||
        (typeof rawCopy.eventId === 'string' && rawCopy.eventId.trim()
          ? rawCopy.eventId.trim()
          : makeEventId())
    );
    const timestamp = String(
      explicitTimestamp ||
        (typeof rawCopy.timestamp === 'string' && rawCopy.timestamp.trim()
          ? rawCopy.timestamp.trim()
          : new Date().toISOString())
    );

    let innerData: Record<string, unknown>;
    if (
      rawCopy.data &&
      typeof rawCopy.data === 'object' &&
      !Array.isArray(rawCopy.data)
    ) {
      innerData = { ...(rawCopy.data as Record<string, unknown>) };
    } else {
      delete rawCopy.eventId;
      delete rawCopy.timestamp;
      delete rawCopy.clientId;
      innerData = rawCopy;
    }

    if (Object.keys(innerData).length === 0) {
      throw new DataStackConfigError(
        'Event payload cannot be empty after stripping envelope metadata.'
      );
    }

    return {
      clientId: this.clientId,
      eventId,
      timestamp,
      data: innerData,
    };
  }

  private async emitSocketSingle(
    envelope: DataStackEnvelope
  ): Promise<DataStackSendResult | null> {
    if (!this.isConnected || !this.socket || !this.socket.connected) {
      return null;
    }

    return new Promise<DataStackSendResult | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(null);
      }, this.config.requestTimeoutMs);

      this.socket!.emit(
        'sync_data',
        {
          clientId: envelope.clientId,
          eventId: envelope.eventId,
          timestamp: envelope.timestamp,
          data: envelope.data,
        },
        (ack: Record<string, unknown> | undefined) => {
          clearTimeout(timer);
          if (!ack || typeof ack !== 'object') {
            resolve(null);
            return;
          }
          if (ack.success === true) {
            this.transportState = 'IDLE_WS';
            const isDuplicate =
              ack.note === 'DUPLICATE_DROPPED' ||
              ack.note === 'DUPLICATE_EVENT' ||
              ack.duplicate === true;
            resolve({
              success: true,
              transport: 'websocket',
              eventId: String(ack.eventId || envelope.eventId),
              accepted: isDuplicate ? 0 : 1,
              duplicates: isDuplicate ? 1 : 0,
            });
            return;
          }
          const code = String(ack.code || 'SOCKET_REJECTED');
          const msg = String(ack.error || 'Socket event rejected');
          const authErr = classifyAuthRejection(code, msg);
          if (authErr) {
            this.disconnect();
            reject(
              new DataStackAuthError(msg, authErr.code, authErr.statusCode, ack)
            );
            return;
          }
          if (code === 'STORAGE_QUOTA_EXCEEDED' || code === 'DISK_SPACE_LOW') {
            reject(new DataStackQuotaExceededError(msg, code));
            return;
          }
          if (code === 'PAYLOAD_TOO_LARGE') {
            reject(new DataStackPayloadTooLargeError(msg));
            return;
          }
          if (code === 'RATE_LIMIT_EXCEEDED') {
            reject(new DataStackRateLimitError(msg, [envelope.eventId]));
            return;
          }
          resolve(null);
        }
      );
    });
  }

  private async sendHttpSingle(
    envelope: DataStackEnvelope
  ): Promise<DataStackSendResult> {
    if (!this.config.clientToken) {
      throw new DataStackConfigError(
        'clientToken is required for HTTP event ingestion.'
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs
    );

    let res: Response;
    try {
      res = await this.fetchFn(`${this.config.apiUrl}/api/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.clientToken}`,
        },
        body: JSON.stringify({
          clientId: envelope.clientId || undefined,
          eventId: envelope.eventId,
          timestamp: envelope.timestamp,
          data: envelope.data,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && body.success !== false) {
      this.transportState = 'HTTP_FALLBACK';
      const isDuplicate =
        body.note === 'DUPLICATE_DROPPED' ||
        body.note === 'DUPLICATE_EVENT' ||
        body.duplicate === true;
      return {
        success: true,
        transport: 'http',
        eventId: String(body.eventId || envelope.eventId),
        accepted: isDuplicate ? 0 : 1,
        duplicates: isDuplicate ? 1 : 0,
      };
    }

    const code = String(body.code || `HTTP_${res.status}`);
    const errMsg = String(body.error || `HTTP ${res.status} error`);

    if (res.status === 401) {
      this.heartbeatStopped = true;
      this.stopHeartbeatMonitor();
      const authCode: DataStackAuthErrorCode =
        code === 'CLIENT_TOKEN_EXPIRED'
          ? 'CLIENT_TOKEN_EXPIRED'
          : code === 'TOKEN_ROTATED'
            ? 'TOKEN_ROTATED'
            : 'AUTH_FAILED';
      throw new DataStackAuthError(errMsg, authCode, 401, body);
    }
    if (res.status === 403) {
      this.heartbeatStopped = true;
      this.stopHeartbeatMonitor();
      throw new DataStackAuthError(
        errMsg,
        code === 'CLIENT_IP_FORBIDDEN' ? 'CLIENT_IP_FORBIDDEN' : 'CLIENT_REVOKED',
        403,
        body
      );
    }
    if (res.status === 413 || code === 'PAYLOAD_TOO_LARGE') {
      throw new DataStackPayloadTooLargeError(errMsg, body);
    }
    if (res.status === 429 || code === 'RATE_LIMIT_EXCEEDED') {
      throw new DataStackRateLimitError(errMsg, [envelope.eventId], body);
    }
    if (
      res.status === 507 ||
      code === 'STORAGE_QUOTA_EXCEEDED' ||
      code === 'DISK_SPACE_LOW'
    ) {
      throw new DataStackQuotaExceededError(
        errMsg,
        code === 'DISK_SPACE_LOW' ? 'DISK_SPACE_LOW' : 'STORAGE_QUOTA_EXCEEDED',
        body
      );
    }

    throw new DataStackError(errMsg, code, res.status, body);
  }

  /**
   * Sends a single telemetry event via WebSocket primary transport, falling back
   * automatically to HTTP `POST /api/events` and offline disk spooling.
   */
  public async send(
    payload: DataStackEventPayload
  ): Promise<DataStackSendResult> {
    const task = (async (): Promise<DataStackSendResult> => {
      const envelope = this.normalizeSingleEnvelope(payload);

      // 1. Try active WebSocket
      const wsResult = await this.emitSocketSingle(envelope);
      if (wsResult) {
        if (this.spooler.count() > 0) {
          void this.flushSpool().catch(() => {});
        }
        return wsResult;
      }

      // 2. Try HTTP Fallback with bounded retry on 429 / transient 5xx
      if (this.config.enableHttpFallback) {
        let attempt = 0;
        while (attempt <= this.config.maxRetries) {
          try {
            const httpRes = await this.sendHttpSingle(envelope);
            if (this.spooler.count() > 0) {
              void this.flushSpool().catch(() => {});
            }
            return httpRes;
          } catch (err) {
            if (
              err instanceof DataStackAuthError ||
              err instanceof DataStackQuotaExceededError ||
              err instanceof DataStackPayloadTooLargeError ||
              err instanceof DataStackConfigError
            ) {
              throw err;
            }
            if (
              err instanceof DataStackRateLimitError &&
              attempt < this.config.maxRetries
            ) {
              attempt += 1;
              await new Promise((r) => setTimeout(r, 50 * attempt));
              continue;
            }
            if (err instanceof DataStackRateLimitError) {
              throw err;
            }
            break;
          }
        }
      }

      // 3. Offline Disk Spool fallback
      if (this.spooler.enabled) {
        const spooled = this.spooler.enqueue(envelope);
        if (spooled > 0) {
          this.transportState = 'OFFLINE_SPOOL';
          return {
            success: true,
            transport: 'spool',
            eventId: envelope.eventId,
            accepted: 0,
            spooled,
          };
        }
      }

      throw new DataStackError(
        'Failed to deliver event via WebSocket, HTTP fallback, or offline spool.',
        'TRANSPORT_UNAVAILABLE',
        503
      );
    })();

    return this.trackInFlight(task);
  }

  /**
   * Alias for `send()` for 1:1 naming parity with Python SDK (`client.sync()`).
   */
  public async sync(
    payload: DataStackEventPayload
  ): Promise<DataStackSendResult> {
    return this.send(payload);
  }

  private async sendBatchChunkInternal(
    chunk: DataStackEnvelope[]
  ): Promise<DataStackSendResult> {
    // 1. Try WebSocket batch_sync if connected
    if (this.isConnected && this.socket && this.socket.connected) {
      const wsBatchRes = await new Promise<DataStackSendResult | null>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => resolve(null),
            this.config.requestTimeoutMs
          );
          this.socket!.emit(
            'batch_sync',
            chunk.map((item) => ({
              clientId: item.clientId || this.clientId || undefined,
              eventId: item.eventId,
              timestamp: item.timestamp,
              data: item.data,
            })),
            (ack: Record<string, unknown> | undefined) => {
              clearTimeout(timer);
              if (!ack || typeof ack !== 'object') {
                resolve(null);
                return;
              }
              if (ack.success === true) {
                const rateLimited = Array.isArray(ack.rateLimitedEventIds)
                  ? (ack.rateLimitedEventIds as string[])
                  : [];
                const duplicates = Number(ack.duplicates ?? 0);
                const acceptedVal =
                  ack.processed ??
                  ack.processedCount ??
                  ack.accepted ??
                  Math.max(0, chunk.length - rateLimited.length - duplicates);
                resolve({
                  success: true,
                  transport: 'websocket',
                  accepted: Number(acceptedVal),
                  duplicates,
                  rateLimitedEventIds: rateLimited,
                });
                return;
              }
              const code = String(ack.code || 'BATCH_REJECTED');
              const msg = String(ack.error || 'Batch rejected');
              const authErr = classifyAuthRejection(code, msg);
              if (authErr) {
                this.disconnect();
                reject(
                  new DataStackAuthError(
                    msg,
                    authErr.code,
                    authErr.statusCode,
                    ack
                  )
                );
                return;
              }
              if (code === 'STORAGE_QUOTA_EXCEEDED' || code === 'DISK_SPACE_LOW') {
                reject(new DataStackQuotaExceededError(msg, code));
                return;
              }
              if (code === 'PAYLOAD_TOO_LARGE') {
                reject(new DataStackPayloadTooLargeError(msg));
                return;
              }
              if (code === 'RATE_LIMIT_EXCEEDED') {
                const rateLimited = Array.isArray(ack.rateLimitedEventIds)
                  ? (ack.rateLimitedEventIds as string[])
                  : chunk.map((c) => c.eventId);
                reject(new DataStackRateLimitError(msg, rateLimited));
                return;
              }
              resolve(null);
            }
          );
        }
      );

      if (wsBatchRes) {
        return wsBatchRes;
      }
    }

    // 2. Try HTTP POST /api/events batch
    if (!this.config.enableHttpFallback) {
      throw new DataStackError(
        'WebSocket disconnected and HTTP fallback is disabled.',
        'TRANSPORT_UNAVAILABLE',
        503
      );
    }
    if (!this.config.clientToken) {
      throw new DataStackConfigError(
        'clientToken is required for HTTP batch ingestion.'
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs
    );
    let res: Response;
    try {
      res = await this.fetchFn(`${this.config.apiUrl}/api/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.clientToken}`,
        },
        body: JSON.stringify({
          clientId: this.clientId || undefined,
          batch: chunk.map((item) => ({
            eventId: item.eventId,
            timestamp: item.timestamp,
            data: item.data,
          })),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const rateLimited = Array.isArray(body.rateLimitedEventIds)
      ? (body.rateLimitedEventIds as string[])
      : [];

    if (res.ok && body.success !== false) {
      this.transportState = 'HTTP_FALLBACK';
      const duplicates = Number(body.duplicates ?? 0);
      const acceptedVal =
        body.processed ??
        body.processedCount ??
        body.accepted ??
        Math.max(0, chunk.length - rateLimited.length - duplicates);
      return {
        success: true,
        transport: 'http',
        accepted: Number(acceptedVal),
        duplicates,
        rateLimitedEventIds: rateLimited,
      };
    }

    const code = String(body.code || `HTTP_${res.status}`);
    const errMsg = String(body.error || `HTTP ${res.status} batch error`);

    if (res.status === 401) {
      this.heartbeatStopped = true;
      this.stopHeartbeatMonitor();
      const authCode: DataStackAuthErrorCode =
        code === 'CLIENT_TOKEN_EXPIRED'
          ? 'CLIENT_TOKEN_EXPIRED'
          : code === 'TOKEN_ROTATED'
            ? 'TOKEN_ROTATED'
            : 'AUTH_FAILED';
      throw new DataStackAuthError(errMsg, authCode, 401, body);
    }
    if (res.status === 403) {
      this.heartbeatStopped = true;
      this.stopHeartbeatMonitor();
      throw new DataStackAuthError(
        errMsg,
        code === 'CLIENT_IP_FORBIDDEN' ? 'CLIENT_IP_FORBIDDEN' : 'CLIENT_REVOKED',
        403,
        body
      );
    }
    if (res.status === 413 || code === 'PAYLOAD_TOO_LARGE') {
      throw new DataStackPayloadTooLargeError(errMsg, body);
    }
    if (res.status === 429 || code === 'RATE_LIMIT_EXCEEDED') {
      throw new DataStackRateLimitError(
        errMsg,
        rateLimited.length > 0 ? rateLimited : chunk.map((c) => c.eventId),
        body
      );
    }
    if (
      res.status === 507 ||
      code === 'STORAGE_QUOTA_EXCEEDED' ||
      code === 'DISK_SPACE_LOW'
    ) {
      throw new DataStackQuotaExceededError(
        errMsg,
        code === 'DISK_SPACE_LOW' ? 'DISK_SPACE_LOW' : 'STORAGE_QUOTA_EXCEEDED',
        body
      );
    }

    throw new DataStackError(errMsg, code, res.status, body);
  }

  private async deliverChunkWithSplitAndRetry(
    chunk: DataStackEnvelope[],
    allowSpoolFallback = true
  ): Promise<DataStackSendResult & { unprocessedEnvelopes?: DataStackEnvelope[] }> {
    let pending = [...chunk];
    let totalAccepted = 0;
    let totalDuplicates = 0;
    let totalSpooled = 0;
    let lastTransport: 'websocket' | 'http' | 'spool' = 'http';
    let attempt = 0;

    while (pending.length > 0) {
      try {
        const res = await this.sendBatchChunkInternal(pending);
        lastTransport = res.transport;
        const rateLimitedSet = new Set(res.rateLimitedEventIds || []);
        const duplicatesNow = res.duplicates || 0;
        totalDuplicates += duplicatesNow;

        if (rateLimitedSet.size === 0) {
          totalAccepted += res.accepted ?? Math.max(0, pending.length - duplicatesNow);
          pending = [];
          break;
        }

        const acceptedNow =
          res.accepted ??
          Math.max(0, pending.length - rateLimitedSet.size - duplicatesNow);
        totalAccepted += acceptedNow;
        pending = pending.filter((item) => rateLimitedSet.has(item.eventId));

        if (attempt >= this.config.maxRetries) {
          if (!allowSpoolFallback) {
            return {
              success: false,
              transport: lastTransport,
              accepted: totalAccepted,
              duplicates: totalDuplicates,
              spooled: totalSpooled,
              rateLimitedEventIds: pending.map((p) => p.eventId),
              unprocessedItems: pending.map((p) => p.data),
              unprocessedEnvelopes: pending,
            };
          }
          throw new DataStackRateLimitError(
            `Rate limit exceeded for ${pending.length} event(s) after ${this.config.maxRetries} retries.`,
            pending.map((p) => p.eventId)
          );
        }
        attempt += 1;
        await new Promise((r) => setTimeout(r, 50 * attempt));
      } catch (err) {
        if (
          err instanceof DataStackPayloadTooLargeError &&
          pending.length > 1
        ) {
          const mid = Math.floor(pending.length / 2);
          const left = await this.deliverChunkWithSplitAndRetry(
            pending.slice(0, mid),
            allowSpoolFallback
          );
          const right = await this.deliverChunkWithSplitAndRetry(
            pending.slice(mid),
            allowSpoolFallback
          );
          const combinedEnvelopes = [
            ...(left.unprocessedEnvelopes || []),
            ...(right.unprocessedEnvelopes || []),
          ];
          const combinedItems = [
            ...(left.unprocessedItems || []),
            ...(right.unprocessedItems || []),
          ];
          return {
            success: left.success && right.success,
            transport: right.transport,
            accepted: (left.accepted || 0) + (right.accepted || 0),
            duplicates: (left.duplicates || 0) + (right.duplicates || 0),
            spooled: (left.spooled || 0) + (right.spooled || 0),
            ...(combinedItems.length > 0 ? { unprocessedItems: combinedItems } : {}),
            ...(combinedEnvelopes.length > 0
              ? { unprocessedEnvelopes: combinedEnvelopes }
              : {}),
          };
        }

        if (err instanceof DataStackRateLimitError) {
          const rlSet = new Set(err.rateLimitedEventIds);
          if (rlSet.size > 0 && rlSet.size < pending.length) {
            totalAccepted += pending.length - rlSet.size;
            pending = pending.filter((p) => rlSet.has(p.eventId));
          }
          if (attempt < this.config.maxRetries) {
            attempt += 1;
            await new Promise((r) => setTimeout(r, 50 * attempt));
            continue;
          }
          if (!allowSpoolFallback) {
            return {
              success: false,
              transport: lastTransport,
              accepted: totalAccepted,
              duplicates: totalDuplicates,
              spooled: totalSpooled,
              rateLimitedEventIds: pending.map((p) => p.eventId),
              unprocessedItems: pending.map((p) => p.data),
              unprocessedEnvelopes: pending,
            };
          }
          throw err;
        }

        if (
          err instanceof DataStackAuthError ||
          err instanceof DataStackQuotaExceededError ||
          err instanceof DataStackPayloadTooLargeError ||
          err instanceof DataStackConfigError
        ) {
          throw err;
        }

        if (allowSpoolFallback && this.spooler.enabled) {
          const spooled = this.spooler.enqueue(pending);
          if (spooled > 0) {
            totalSpooled += spooled;
            lastTransport = 'spool';
            this.transportState = 'OFFLINE_SPOOL';
            pending = [];
            break;
          }
        }

        throw err;
      }
    }

    return {
      success: pending.length === 0,
      transport: lastTransport,
      accepted: totalAccepted,
      duplicates: totalDuplicates,
      spooled: totalSpooled,
      unprocessedItems: pending.map((p) => p.data),
      ...(pending.length > 0 ? { unprocessedEnvelopes: pending } : {}),
    };
  }

  /**
   * Sends a batch of telemetry events with automatic chunking (`batchChunkSize`),
   * recursive `413 PAYLOAD_TOO_LARGE` splitting, partial-batch `429` retry, and
   * offline disk spooling.
   */
  public async sendBatch(
    events: DataStackEventPayload[],
    options?: { chunkSize?: number }
  ): Promise<DataStackSendResult> {
    const task = (async (): Promise<DataStackSendResult> => {
      if (!Array.isArray(events) || events.length === 0) {
        throw new DataStackConfigError(
          'sendBatch requires a non-empty array of event objects.'
        );
      }

      const envelopes = events.map((ev) => this.normalizeSingleEnvelope(ev));
      const chunkSize = Math.max(
        1,
        Math.min(1000, Number(options?.chunkSize ?? this.config.batchChunkSize))
      );

      let totalAccepted = 0;
      let totalDuplicates = 0;
      let totalSpooled = 0;
      let lastTransport: 'websocket' | 'http' | 'spool' = 'http';

      for (let i = 0; i < envelopes.length; i += chunkSize) {
        const slice = envelopes.slice(i, i + chunkSize);
        const res = await this.deliverChunkWithSplitAndRetry(slice, true);
        totalAccepted += res.accepted || 0;
        totalDuplicates += res.duplicates || 0;
        totalSpooled += res.spooled || 0;
        lastTransport = res.transport;
      }

      return {
        success: true,
        transport: lastTransport,
        accepted: totalAccepted,
        duplicates: totalDuplicates,
        spooled: totalSpooled,
      };
    })();

    return this.trackInFlight(task);
  }

  /**
   * Alias for `sendBatch()` for 1:1 parity with Python SDK (`client.batch_sync()`).
   */
  public async batchSync(
    events: DataStackEventPayload[],
    options?: { chunkSize?: number }
  ): Promise<DataStackSendResult> {
    return this.sendBatch(events, options);
  }

  /**
   * Ingests a `.csv`, `.json`, `.jsonl`, or `.ndjson` file directly with
   * deterministic SHA-256 `eventId` deduplication (`file_<stem>_<row>_<hash>`).
   */
  public async sendFile(
    filePath: string,
    options?: { chunkSize?: number }
  ): Promise<DataStackFileSendResult> {
    const task = (async (): Promise<DataStackFileSendResult> => {
      const resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath)) {
        throw new DataStackFileError(`File not found: ${resolvedPath}`);
      }

      const ext = path.extname(resolvedPath).toLowerCase();
      const fileStem = path.basename(resolvedPath, ext);
      const rawContent = fs.readFileSync(resolvedPath, 'utf8');

      let records: DataStackEventPayload[] = [];

      if (ext === '.csv') {
        const parsed = parseCsvSync(rawContent, {
          columns: true,
          skip_empty_lines: true,
          relax_column_count: true,
          trim: true,
        }) as DataStackEventPayload[];
        records = parsed;
      } else if (ext === '.json') {
        try {
          const parsed = JSON.parse(rawContent) as unknown;
          if (Array.isArray(parsed)) {
            records = parsed as DataStackEventPayload[];
          } else if (parsed && typeof parsed === 'object') {
            records = [parsed as DataStackEventPayload];
          } else {
            throw new DataStackFileError(
              'JSON file must contain an object or array of objects.'
            );
          }
        } catch (err) {
          if (err instanceof DataStackFileError) throw err;
          throw new DataStackFileError(
            `Invalid JSON file (${resolvedPath}): ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else if (ext === '.jsonl' || ext === '.ndjson') {
        const lines = rawContent
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        records = lines.map((line, idx) => {
          try {
            const obj = JSON.parse(line) as unknown;
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
              throw new Error('Line is not a JSON object');
            }
            return obj as DataStackEventPayload;
          } catch (err) {
            throw new DataStackFileError(
              `Invalid JSONL at line ${idx + 1}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        });
      } else {
        throw new DataStackFileError(
          `Unsupported file extension '${ext}'. Supported extensions: .csv, .json, .jsonl, .ndjson`
        );
      }

      if (records.length === 0) {
        return {
          success: true,
          transport: this.isConnected ? 'websocket' : 'http',
          filePath: resolvedPath,
          totalRows: 0,
          accepted: 0,
          acceptedRows: 0,
          spooled: 0,
          spooledRows: 0,
          chunksSent: 0,
        };
      }

      const envelopes: DataStackEnvelope[] = records.map((rec, idx) => {
        const deterministicId =
          typeof rec.eventId === 'string' && rec.eventId.trim()
            ? rec.eventId.trim()
            : makeDeterministicFileEventId(fileStem, idx, rec);
        return this.normalizeSingleEnvelope(rec, deterministicId);
      });

      const chunkSize = Math.max(
        1,
        Math.min(1000, Number(options?.chunkSize ?? this.config.batchChunkSize))
      );

      let acceptedRows = 0;
      let duplicateRows = 0;
      let spooledRows = 0;
      let chunksSent = 0;
      let lastTransport: 'websocket' | 'http' | 'spool' = 'http';

      for (let i = 0; i < envelopes.length; i += chunkSize) {
        const slice = envelopes.slice(i, i + chunkSize);
        const res = await this.deliverChunkWithSplitAndRetry(slice, true);
        acceptedRows += res.accepted || 0;
        duplicateRows += res.duplicates || 0;
        spooledRows += res.spooled || 0;
        chunksSent += 1;
        lastTransport = res.transport;
      }

      return {
        success: acceptedRows + duplicateRows + spooledRows === envelopes.length,
        transport: lastTransport,
        filePath: resolvedPath,
        totalRows: envelopes.length,
        accepted: acceptedRows,
        acceptedRows,
        duplicates: duplicateRows,
        spooled: spooledRows,
        spooledRows,
        chunksSent,
      };
    })();

    return this.trackInFlight(task);
  }

  /**
   * Replays locally spooled events from `.datastack_spool/spool.jsonl` to the server.
   */
  public async flushSpool(): Promise<{ drained: number; remaining: number }> {
    if (!this.spooler.enabled || this.isDrainingSpool) {
      return { drained: 0, remaining: this.spooler.count() };
    }
    this.isDrainingSpool = true;
    let drained = 0;
    try {
      while (this.spooler.count() > 0) {
        const batch = this.spooler.peekBatch(this.config.batchChunkSize);
        if (batch.length === 0) break;
        const res = await this.deliverChunkWithSplitAndRetry(batch, false);
        const processedNow = res.accepted || 0;
        const duplicatesNow = res.duplicates || 0;
        const remaining = res.unprocessedEnvelopes ?? [];

        if (!res.success && processedNow === 0 && duplicatesNow === 0) {
          break;
        }

        if (remaining.length > 0) {
          const acked = this.spooler.ackAndRequeueFront(batch.length, remaining);
          drained += acked;
          break;
        }

        this.spooler.ackAndRequeueFront(batch.length, []);
        drained += batch.length;
      }
    } finally {
      this.isDrainingSpool = false;
    }
    return { drained, remaining: this.spooler.count() };
  }

  /**
   * Gracefully awaits all in-flight telemetry requests, attempts to drain any
   * spooled events within `timeoutMs`, and closes the Socket.IO connection.
   */
  public async shutdown(
    timeoutMs = 5000,
    options?: { throwOnTimeout?: boolean }
  ): Promise<{ drained: boolean; remainingInFlight: number; remainingSpooled: number }> {
    const deadline = Date.now() + Math.max(50, timeoutMs);

    const waitWork = (async () => {
      while (this.inFlightSet.size > 0 && Date.now() < deadline) {
        await Promise.race([
          Promise.allSettled(Array.from(this.inFlightSet)),
          new Promise((r) => setTimeout(r, 25)),
        ]);
      }
      if (this.spooler.count() > 0 && Date.now() < deadline) {
        try {
          await this.flushSpool();
        } catch {
          // Best-effort spool drain before shutdown
        }
      }
    })();

    const remainingMs = Math.max(10, deadline - Date.now());
    let timedOut = false;
    await Promise.race([
      waitWork,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, remainingMs)
      ),
    ]);

    this.disconnect();
    const remainingInFlight = this.inFlightSet.size;
    const remainingSpooled = this.spooler.count();

    if (timedOut && remainingInFlight > 0 && options?.throwOnTimeout) {
      throw new DataStackShutdownTimeoutError(
        `Graceful shutdown timed out after ${timeoutMs}ms with ${remainingInFlight} in-flight request(s).`
      );
    }

    return {
      drained: !timedOut && remainingInFlight === 0,
      remainingInFlight,
      remainingSpooled,
    };
  }

  public status(): DataStackStatusSnapshot {
    return {
      connected: this.isConnected && Boolean(this.socket?.connected),
      transportState: this.transportState,
      clientId: this.clientId,
      serverUrl: this.config.serverUrl,
      apiUrl: this.config.apiUrl,
      spooledCount: this.spooler.count(),
      spooledBytes: this.spooler.sizeBytes(),
      inFlightRequests: this.inFlightSet.size,
      heartbeatActive: this.heartbeatTimer !== null,
    };
  }
}

export { DataStackClient as DataStack };
export default DataStackClient;
