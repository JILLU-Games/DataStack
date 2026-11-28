import crypto from 'node:crypto';
import { Writable } from 'node:stream';
import Redis from 'ioredis';
import { CSVStorageManager, DataEvent } from '../Storage/csvStorage';

export type EventSubscriber = (event: DataEvent) => void;
export type FlushCallback = (count: number, files: string[]) => void;

export interface RedisBufferClient {
  status?: string;
  rpush(key: string, ...values: string[]): Promise<number>;
  lpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  llen(key: string): Promise<number>;
  set(
    key: string,
    value: string,
    pxMode: 'PX',
    ttlMs: number,
    nxMode: 'NX',
  ): Promise<string | null>;
  get?(key: string): Promise<string | null>;
  incr?(key: string): Promise<number>;
  pexpire?(key: string, ttlMs: number): Promise<number>;
  hget?(key: string, field: string): Promise<string | null>;
  hset?(key: string, field: string, value: string): Promise<number>;
  hdel?(key: string, ...fields: string[]): Promise<number>;
  sismember?(key: string, member: string): Promise<number>;
  sadd?(key: string, ...members: string[]): Promise<number>;
  srem?(key: string, ...members: string[]): Promise<number>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  quit?: () => Promise<unknown>;
  disconnect?: () => void;
}

export const REDIS_BUFFER_KEY = 'datastack:buffer:events';
export const REDIS_RECENT_KEY = 'datastack:recent:events';
export const REDIS_FLUSH_LOCK_KEY = 'datastack:flush:lock';
const REDIS_CLIENTS_DELETED_KEY = 'datastack:clients:deleted';
export const DEFAULT_REDIS_RECENT_LIMIT = 500;
export const MAX_REDIS_RECENT_LIMIT = 5000;
const FLUSH_LOCK_TTL_MS = 30000;
const FLUSH_LOCK_WAIT_MS = 400;
const FLUSH_LOCK_RETRY_MS = 25;
const UNLOCK_LUA_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
const RENEW_LOCK_LUA_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';
export const PURGE_CLIENT_LIST_LUA_SCRIPT = `
-- DATASTACK_PURGE_CLIENT_LIST
local key = KEYS[1]
local target = ARGV[1]
local items = redis.call("LRANGE", key, 0, -1)
local removed = 0
local kept = {}
for i = 1, #items do
  local raw = items[i]
  local ok, obj = pcall(cjson.decode, raw)
  local cid = ""
  if ok and type(obj) == "table" and obj.clientId ~= nil then
    cid = string.lower(tostring(obj.clientId))
    cid = string.gsub(cid, "^%s*(.-)%s*$", "%1")
    cid = string.gsub(cid, "[^a-z0-9_-]", "_")
  end
  if cid == target then
    removed = removed + 1
  else
    kept[#kept + 1] = raw
  end
end
if removed > 0 then
  redis.call("DEL", key)
  local chunk = 500
  for i = 1, #kept, chunk do
    local stop = math.min(i + chunk - 1, #kept)
    redis.call("RPUSH", key, unpack(kept, i, stop))
  end
end
return removed
`.trim();

export function resolveRedisRecentLimit(batchFlushThreshold?: number): number {
  const envRaw = Number(process.env.DATASTACK_RECENT_LIMIT);
  if (Number.isFinite(envRaw) && envRaw >= 100) {
    return Math.min(MAX_REDIS_RECENT_LIMIT, Math.floor(envRaw));
  }
  const threshold = Number(batchFlushThreshold) || DEFAULT_REDIS_RECENT_LIMIT;
  return Math.min(
    MAX_REDIS_RECENT_LIMIT,
    Math.max(DEFAULT_REDIS_RECENT_LIMIT, Math.floor(threshold)),
  );
}

export interface FlushOptions {
  waitMs?: number;
  lockTtlMs?: number;
  throwOnLockTimeout?: boolean;
}

export interface FlushResult {
  count: number;
  files: string[];
  lockTimedOut?: boolean;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBufferClientId(clientId: string): string {
  return String(clientId || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
}

interface BufferGlobalState {
  buffer: DataEvent[];
  recentEvents: DataEvent[];
  batchFlushThreshold: number;
  batchFlushIntervalMs: number;
  flushTimer: NodeJS.Timeout | null;
  subscribers: Set<EventSubscriber>;
  flushListeners: Set<FlushCallback>;
  totalIngested: number;
  totalFlushed: number;
  isFlushing: boolean;
  activeFlushPromise: Promise<FlushResult> | null;
  redisClient: RedisBufferClient | null | undefined;
  redisUrlConfigured: string;
  redisConnected: boolean;
  redisTestOverride: RedisBufferClient | null | undefined;
  pendingRedisWrites: Set<Promise<void>>;
  deletedClientIds: Set<string>;
  shutdownHooks: Set<() => Promise<unknown>>;
}

type BufferGlobals = typeof globalThis & {
  __dataStackBufferState?: BufferGlobalState;
  __dataStackBufferShutdownRegistered?: boolean;
  __dataStackBufferShuttingDown?: Promise<void> | null;
};

const globals = globalThis as BufferGlobals;

function getState(): BufferGlobalState {
  if (!globals.__dataStackBufferState) {
    globals.__dataStackBufferState = {
      buffer: [],
      recentEvents: [],
      batchFlushThreshold: 500,
      batchFlushIntervalMs: 2000,
      flushTimer: null,
      subscribers: new Set(),
      flushListeners: new Set(),
      totalIngested: 0,
      totalFlushed: 0,
      isFlushing: false,
      activeFlushPromise: null,
      redisClient: undefined,
      redisUrlConfigured: '',
      redisConnected: false,
      redisTestOverride: undefined,
      pendingRedisWrites: new Set(),
      deletedClientIds: new Set(),
      shutdownHooks: new Set(),
    };
  }
  if (!globals.__dataStackBufferState.deletedClientIds) {
    globals.__dataStackBufferState.deletedClientIds = new Set();
  }
  if (!globals.__dataStackBufferState.shutdownHooks) {
    globals.__dataStackBufferState.shutdownHooks = new Set();
  }
  return globals.__dataStackBufferState;
}

function getRedisClient(): RedisBufferClient | null {
  const state = getState();
  if (state.redisTestOverride !== undefined) {
    return state.redisTestOverride;
  }

  const configuredUrl = (process.env.REDIS_URL || '').trim();
  if (!configuredUrl) {
    if (state.redisClient && typeof state.redisClient.disconnect === 'function') {
      try {
        state.redisClient.disconnect();
      } catch {
        // ignore
      }
    }
    state.redisClient = null;
    state.redisUrlConfigured = '';
    state.redisConnected = false;
    return null;
  }

  if (state.redisClient && state.redisUrlConfigured === configuredUrl) {
    return state.redisClient;
  }

  if (state.redisClient && typeof state.redisClient.disconnect === 'function') {
    try {
      state.redisClient.disconnect();
    } catch {
      // ignore
    }
  }

  try {
    const client = new Redis(configuredUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      retryStrategy: (times: number) => Math.min(times * 250, 3000),
    });

    client.on('ready', () => {
      state.redisConnected = true;
    });
    client.on('connect', () => {
      state.redisConnected = true;
    });
    client.on('close', () => {
      state.redisConnected = false;
    });
    client.on('end', () => {
      state.redisConnected = false;
    });
    client.on('error', () => {
      state.redisConnected = false;
    });

    state.redisClient = client as unknown as RedisBufferClient;
    state.redisUrlConfigured = configuredUrl;
    state.redisConnected = client.status === 'ready' || client.status === 'connect';
    return state.redisClient;
  } catch {
    state.redisClient = null;
    state.redisUrlConfigured = configuredUrl;
    state.redisConnected = false;
    return null;
  }
}

export class DataBufferEngine {
  public static getRecentLimit(): number {
    return resolveRedisRecentLimit(getState().batchFlushThreshold);
  }

  public static get batchFlushThreshold(): number {
    return getState().batchFlushThreshold;
  }

  public static set batchFlushThreshold(value: number) {
    getState().batchFlushThreshold = Math.max(1, Number(value) || 500);
  }

  public static get batchFlushIntervalMs(): number {
    return getState().batchFlushIntervalMs;
  }

  public static set batchFlushIntervalMs(value: number) {
    this.setFlushInterval(value);
  }

  public static setRedisClientForTests(client: RedisBufferClient | null | undefined): void {
    const state = getState();
    state.redisTestOverride = client;
    state.redisConnected = Boolean(client);
  }

  public static getRedisClient(): RedisBufferClient | null {
    return getRedisClient();
  }

  public static async shutdown(): Promise<void> {
    const state = getState();
    if (state.flushTimer) {
      clearInterval(state.flushTimer);
      state.flushTimer = null;
    }
    if (state.pendingRedisWrites.size > 0) {
      await Promise.allSettled([...state.pendingRedisWrites]);
    }
    const client = state.redisClient;
    state.redisClient = undefined;
    state.redisUrlConfigured = '';
    state.redisConnected = false;
    state.redisTestOverride = undefined;
    state.deletedClientIds.clear();
    if (client) {
      try {
        if (typeof client.quit === 'function') {
          await client.quit();
        } else if (typeof client.disconnect === 'function') {
          client.disconnect();
        }
      } catch {
        if (typeof client.disconnect === 'function') {
          client.disconnect();
        }
      }
    }
  }

  public static registerShutdownHook(hook: () => Promise<unknown>): () => void {
    const state = getState();
    state.shutdownHooks.add(hook);
    return () => {
      state.shutdownHooks.delete(hook);
    };
  }

  public static async flushAndShutdownOnSignal(): Promise<void> {
    if (globals.__dataStackBufferShuttingDown) {
      return globals.__dataStackBufferShuttingDown;
    }

    const run = (async () => {
      try {
        const hooks = [...getState().shutdownHooks];
        await Promise.race([
          Promise.allSettled([
            this.flush().catch(() => undefined),
            ...hooks.map((hook) =>
              Promise.resolve()
                .then(() => hook())
                .catch(() => undefined),
            ),
          ]),
          new Promise<void>((resolve) => setTimeout(resolve, 4000)),
        ]);
      } finally {
        await Promise.race([
          this.shutdown().catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 1500)),
        ]);
        globals.__dataStackBufferShuttingDown = null;
      }
    })();

    globals.__dataStackBufferShuttingDown = run;
    return run;
  }

  public static init() {
    const state = getState();
    if (!state.flushTimer) {
      state.flushTimer = setInterval(() => {
        void this.flush().catch(() => undefined);
      }, state.batchFlushIntervalMs);
    }

    if (
      typeof process !== 'undefined' &&
      typeof process.once === 'function' &&
      !globals.__dataStackBufferShutdownRegistered
    ) {
      globals.__dataStackBufferShutdownRegistered = true;
      const flushOnExit = () => {
        void this.flushAndShutdownOnSignal().finally(() => {
          if (
            process.env.NODE_ENV === 'production' &&
            !process.execArgv.includes('--test')
          ) {
            process.exit(0);
          }
        });
      };
      process.once('SIGTERM', flushOnExit);
      process.once('SIGINT', flushOnExit);
    }
  }

  /**
   * Updates flush interval and immediately restarts the active interval timer.
   */
  public static setFlushInterval(intervalMs: number) {
    const state = getState();
    const nextInterval = Math.max(100, Number(intervalMs) || 2000);
    state.batchFlushIntervalMs = nextInterval;

    if (state.flushTimer) {
      clearInterval(state.flushTimer);
      state.flushTimer = null;
    }

    state.flushTimer = setInterval(() => {
      void this.flush().catch(() => undefined);
    }, state.batchFlushIntervalMs);
  }

  private static recordLocalMetaAndNotify(event: DataEvent): void {
    const state = getState();
    state.totalIngested += 1;
    state.recentEvents.unshift(event);
    const recentLimit = this.getRecentLimit();
    while (state.recentEvents.length > recentLimit) {
      state.recentEvents.pop();
    }

    for (const sub of state.subscribers) {
      try {
        sub(event);
      } catch {
        // Ignore subscriber error
      }
    }
  }

  private static async writeEventsToRedisOrFallback(events: DataEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const state = getState();
    const redis = getRedisClient();

    if (redis) {
      const serialized = events.map((e) => JSON.stringify(e));
      let bufferLen: number | null = null;
      try {
        bufferLen = await redis.rpush(REDIS_BUFFER_KEY, ...serialized);
        state.redisConnected = true;
      } catch {
        state.redisConnected = false;
      }

      if (bufferLen !== null) {
        // Best-effort recent list mirror: never duplicate into RAM buffer once rpush succeeded
        try {
          const recentLimit = this.getRecentLimit();
          await redis.lpush(REDIS_RECENT_KEY, ...serialized);
          await redis.ltrim(REDIS_RECENT_KEY, 0, recentLimit - 1);
        } catch {
          // Non-fatal: events are already committed in REDIS_BUFFER_KEY and state.recentEvents
        }
        return Number(bufferLen) + state.buffer.length;
      }
    }

    state.buffer.push(...events);
    return state.buffer.length;
  }

  /**
   * Synchronous-signature push (queues to Redis asynchronously when configured, with automatic RAM fallback).
   */
  public static push(event: DataEvent): void {
    const state = getState();
    this.recordLocalMetaAndNotify(event);

    const redis = getRedisClient();
    if (redis) {
      const op = this.writeEventsToRedisOrFallback([event]).then((queuedCount) => {
        if (queuedCount >= state.batchFlushThreshold) {
          void this.flush().catch(() => undefined);
        }
      });
      state.pendingRedisWrites.add(op);
      void op.finally(() => {
        state.pendingRedisWrites.delete(op);
      });
      return;
    }

    state.buffer.push(event);
    if (state.buffer.length >= state.batchFlushThreshold) {
      void this.flush().catch(() => undefined);
    }
  }

  /**
   * Async single-event push (awaited by API routes so Redis persistence is guaranteed before HTTP response).
   */
  public static async pushAsync(event: DataEvent): Promise<void> {
    await this.pushBatchAsync([event]);
  }

  /**
   * Async batch push with shared Redis durability and RAM fallback.
   */
  public static async pushBatchAsync(events: DataEvent[]): Promise<void> {
    if (!events || events.length === 0) return;
    const state = getState();
    for (const evt of events) {
      this.recordLocalMetaAndNotify(evt);
    }

    const queuedCount = await this.writeEventsToRedisOrFallback(events);
    if (queuedCount >= state.batchFlushThreshold) {
      void this.flush().catch(() => undefined);
    }
  }

  private static async isClientDeletedForBuffer(
    clientId: string,
    redis: RedisBufferClient | null,
    cache?: Map<string, boolean>,
  ): Promise<boolean> {
    const normalized = normalizeBufferClientId(clientId);
    if (!normalized) return false;
    const state = getState();
    if (state.deletedClientIds.has(normalized)) return true;
    if (cache && cache.has(normalized)) return Boolean(cache.get(normalized));
    if (redis && typeof redis.sismember === 'function') {
      try {
        const isDeleted =
          Number(await redis.sismember(REDIS_CLIENTS_DELETED_KEY, normalized)) === 1;
        if (cache) cache.set(normalized, isDeleted);
        if (isDeleted) state.deletedClientIds.add(normalized);
        return isDeleted;
      } catch {
        // Ignore transient Redis tombstone lookup error
      }
    }
    if (cache) cache.set(normalized, false);
    return false;
  }

  /**
   * Marks a client deleted in the buffer layer and immediately strips queued local events.
   */
  public static markClientDeleted(clientId: string): void {
    const normalized = normalizeBufferClientId(clientId);
    if (!normalized) return;
    const state = getState();
    state.deletedClientIds.add(normalized);
    state.buffer = state.buffer.filter(
      (evt) => normalizeBufferClientId(evt.clientId) !== normalized,
    );
    state.recentEvents = state.recentEvents.filter(
      (evt) => normalizeBufferClientId(evt.clientId) !== normalized,
    );
  }

  /**
   * Clears deleted tombstone when a client ID is explicitly re-registered.
   */
  public static unmarkClientDeleted(clientId: string): void {
    const normalized = normalizeBufferClientId(clientId);
    if (!normalized) return;
    getState().deletedClientIds.delete(normalized);
  }

  private static async filterRedisListExcludingClient(
    redis: RedisBufferClient,
    listKey: string,
    normalizedClientId: string,
  ): Promise<number> {
    const removed = await redis.eval(
      PURGE_CLIENT_LIST_LUA_SCRIPT,
      1,
      listKey,
      normalizedClientId,
    );
    return Number(removed) || 0;
  }

  /**
   * Purges all queued events for a deleted client from both local RAM and shared Redis queues (BUG-19).
   */
  public static async purgeClientEventsAsync(
    clientId: string,
  ): Promise<{ removedLocal: number; removedRedis: number }> {
    const normalized = normalizeBufferClientId(clientId);
    if (!normalized) return { removedLocal: 0, removedRedis: 0 };

    const state = getState();
    state.deletedClientIds.add(normalized);

    if (state.pendingRedisWrites.size > 0) {
      await Promise.allSettled([...state.pendingRedisWrites]);
    }

    const beforeLocal = state.buffer.length;
    state.buffer = state.buffer.filter(
      (evt) => normalizeBufferClientId(evt.clientId) !== normalized,
    );
    const removedLocal = beforeLocal - state.buffer.length;
    state.recentEvents = state.recentEvents.filter(
      (evt) => normalizeBufferClientId(evt.clientId) !== normalized,
    );

    let removedRedis = 0;
    const redis = getRedisClient();
    if (redis) {
      const lockToken = crypto.randomUUID();
      let lockAcquired = false;
      const deadline = Date.now() + 1500;
      while (true) {
        try {
          const lockRes = await redis.set(
            REDIS_FLUSH_LOCK_KEY,
            lockToken,
            'PX',
            FLUSH_LOCK_TTL_MS,
            'NX',
          );
          state.redisConnected = true;
          if (lockRes === 'OK') {
            lockAcquired = true;
            break;
          }
        } catch {
          state.redisConnected = false;
          break;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleepMs(Math.min(FLUSH_LOCK_RETRY_MS, remaining));
      }

      if (lockAcquired) {
        try {
          removedRedis += await this.filterRedisListExcludingClient(
            redis,
            REDIS_BUFFER_KEY,
            normalized,
          );
          await this.filterRedisListExcludingClient(
            redis,
            REDIS_RECENT_KEY,
            normalized,
          ).catch(() => 0);
        } catch {
          // Flush-time deletedClientIds/tombstone filter remains active as secondary guard
        } finally {
          try {
            await redis.eval(UNLOCK_LUA_SCRIPT, 1, REDIS_FLUSH_LOCK_KEY, lockToken);
          } catch {
            // Lock expires via PX TTL
          }
        }
      }
    }

    return { removedLocal, removedRedis };
  }

  /**
   * Flushes queued events (shared Redis list under distributed lock + local RAM fallback) to partitioned CSV files.
   * Redis LTRIM runs ONLY after CSVStorageManager.appendBatch succeeds and lock ownership is verified.
   */
  public static async flush(options?: FlushOptions): Promise<FlushResult> {
    const state = getState();
    if (state.pendingRedisWrites.size > 0) {
      await Promise.allSettled([...state.pendingRedisWrites]);
    }
    if (state.activeFlushPromise) {
      return state.activeFlushPromise;
    }

    const executeFlush = async (): Promise<FlushResult> => {

      // P02 R-02: examine CSV partitions before replay of an untrimmed Redis
      // batch. Streaming parsing limits memory and handles escaped/newline CSV.
      const excludeAlreadyPersisted = async (events: DataEvent[]): Promise<DataEvent[]> => {
        if (!events.length) return events;
        const fs = await import('node:fs');
        const path = await import('node:path');
        const zlib = await import('node:zlib');
        const { pipeline } = await import('node:stream/promises');
        const { parse } = await import('csv-parse');
        const groups = new Map<string, {
          clientId: string; date: string; ids: Set<string>;
        }>();
        for (const event of events) {
          const clientId = String(event.clientId || 'unknown');
          const date = CSVStorageManager.extractSafePartitionDate(event.timestamp);
          const key = JSON.stringify([clientId, date]);
          if (!groups.has(key)) groups.set(key, { clientId, date, ids: new Set() });
          groups.get(key)!.ids.add(String(event.eventId));
        }
        const persisted = new Set<string>();
        for (const [groupKey, group] of groups) {
          const dir = CSVStorageManager.ensureClientDir(group.clientId);
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isFile() ||
                !/\.csv(?:\.gz)?$/.test(entry.name) ||
                CSVStorageManager.extractSafePartitionDate(
                  entry.name.replace(/\.csv(?:\.gz)?$/, '').replace(/(?:-(?:part|gz)\d+)+$/, ''),
                ) !== group.date) continue;
            const reader = fs.createReadStream(path.join(dir, entry.name));
            const parser = parse({ columns: true, bom: true, skip_empty_lines: true });
            const sink = new Writable({
              objectMode: true,
              write(row: { clientId?: string; eventId?: string }, _enc, done) {
                if (row.clientId === group.clientId && group.ids.has(String(row.eventId))) {
                  persisted.add(JSON.stringify([groupKey, String(row.eventId)]));
                }
                done();
              },
            });
            if (entry.name.endsWith('.gz')) {
              await pipeline(reader, zlib.createGunzip(), parser, sink);
            } else {
              await pipeline(reader, parser, sink);
            }
          }
        }
        const batchSeen = new Set<string>();
        return events.filter((event) => {
          const key = JSON.stringify([String(event.clientId || 'unknown'),
            CSVStorageManager.extractSafePartitionDate(event.timestamp)]);
          const rowKey = JSON.stringify([key, String(event.eventId)]);
          if (persisted.has(rowKey) || batchSeen.has(rowKey)) return false;
          batchSeen.add(rowKey);
          return true;
        });
      };

      state.isFlushing = true;
      let totalWritten = 0;
      let lockTimedOut = false;
      const filesSet = new Set<string>();
      const deletedCheckCache = new Map<string, boolean>();

      try {
        if (state.pendingRedisWrites.size > 0) {
          await Promise.allSettled([...state.pendingRedisWrites]);
        }

        const redis = getRedisClient();
        if (redis) {
          const lockToken = crypto.randomUUID();
          const lockTtlMs = Math.max(50, Number(options?.lockTtlMs) || FLUSH_LOCK_TTL_MS);
          const waitMs = Math.max(
            0,
            options?.waitMs !== undefined ? Number(options.waitMs) : FLUSH_LOCK_WAIT_MS,
          );
          const deadline = Date.now() + waitMs;
          let lockAcquired = false;
          let redisError = false;

          while (true) {
            try {
              const lockResult = await redis.set(
                REDIS_FLUSH_LOCK_KEY,
                lockToken,
                'PX',
                lockTtlMs,
                'NX',
              );
              state.redisConnected = true;
              if (lockResult === 'OK') {
                lockAcquired = true;
                break;
              }
            } catch {
              state.redisConnected = false;
              redisError = true;
              break;
            }

            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              break;
            }
            await sleepMs(Math.min(FLUSH_LOCK_RETRY_MS, remaining));
          }

          if (!lockAcquired && !redisError) {
            lockTimedOut = true;
            if (options?.throwOnLockTimeout === true) {
              throw new Error(
                'FLUSH_LOCK_TIMEOUT: Timed out waiting for distributed Redis flush lock',
              );
            }
          }

          if (lockAcquired) {
            const renewIntervalMs = Math.max(20, Math.floor(lockTtlMs / 3));
            let lastRenewAt = Date.now();
            let lockLost = false;
            let renewInFlight: Promise<boolean> | null = null;

            const renewLockOnce = (): Promise<boolean> => {
              if (renewInFlight) return renewInFlight;
              renewInFlight = (async () => {
                try {
                  const renewed = await redis.eval(
                    RENEW_LOCK_LUA_SCRIPT,
                    1,
                    REDIS_FLUSH_LOCK_KEY,
                    lockToken,
                    String(lockTtlMs),
                  );
                  if (Number(renewed) === 1) {
                    lastRenewAt = Date.now();
                    return true;
                  }
                  lockLost = true;
                  return false;
                } catch {
                  return false;
                } finally {
                  renewInFlight = null;
                }
              })();
              return renewInFlight;
            };

            const renewTimer = setInterval(() => {
              void renewLockOnce();
            }, renewIntervalMs);
            if (typeof renewTimer.unref === 'function') {
              renewTimer.unref();
            }

            try {
              const chunkSize = Math.max(500, state.batchFlushThreshold);
              while (true) {
                if (lockLost) break;

                const rawItems = await redis.lrange(REDIS_BUFFER_KEY, 0, chunkSize - 1);
                if (!rawItems || rawItems.length === 0) {
                  break;
                }

                const parsedBatch: DataEvent[] = [];
                let malformedCount = 0;
                for (const raw of rawItems) {
                  try {
                    const evt = JSON.parse(raw) as DataEvent;
                    if (evt && evt.eventId) {
                      if (
                        await this.isClientDeletedForBuffer(
                          evt.clientId,
                          redis,
                          deletedCheckCache,
                        )
                      ) {
                        continue;
                      }
                      parsedBatch.push(evt);
                    } else {
                      malformedCount += 1;
                    }
                  } catch {
                    malformedCount += 1;
                  }
                }
                if (malformedCount > 0) {
                  console.warn(
                    `[DataBufferEngine] Skipped ${malformedCount} malformed buffered Redis event(s) during flush`,
                  );
                }

                if (Date.now() - lastRenewAt >= renewIntervalMs) {
                  await renewLockOnce();
                }
                if (lockLost) break;

                if (parsedBatch.length > 0) {
                  const unwritten = await excludeAlreadyPersisted(parsedBatch);
                  if (unwritten.length > 0) {
                    const res = await CSVStorageManager.appendBatch(unwritten);
                    totalWritten += res.written;
                    for (const f of res.filesUpdated) filesSet.add(f);
                  }
                }

                if (Date.now() - lastRenewAt >= renewIntervalMs) {
                  await renewLockOnce();
                }
                if (lockLost) {
                  break;
                }

                // Trim strictly AFTER CSVStorageManager.appendBatch resolves and lock ownership holds
                await redis.ltrim(REDIS_BUFFER_KEY, rawItems.length, -1);

                if (rawItems.length < chunkSize) {
                  break;
                }
              }
            } finally {
              clearInterval(renewTimer);
              if (renewInFlight) {
                await renewInFlight.catch(() => false);
              }
              try {
                await redis.eval(UNLOCK_LUA_SCRIPT, 1, REDIS_FLUSH_LOCK_KEY, lockToken);
              } catch {
                // Lock auto-expires after lockTtlMs
              }
            }
          }
        }

        if (state.buffer.length > 0) {
          const ramBatch = [...state.buffer];
          state.buffer = [];
          const validRamBatch: DataEvent[] = [];
          for (const evt of ramBatch) {
            if (
              await this.isClientDeletedForBuffer(
                evt.clientId,
                redis,
                deletedCheckCache,
              )
            ) {
              continue;
            }
            validRamBatch.push(evt);
          }

          if (validRamBatch.length > 0) {
            try {
              const unwritten = await excludeAlreadyPersisted(validRamBatch);
              if (unwritten.length > 0) {
                const res = await CSVStorageManager.appendBatch(unwritten);
                totalWritten += res.written;
                for (const f of res.filesUpdated) filesSet.add(f);
              }
            } catch (err) {
              state.buffer.unshift(...validRamBatch);
              throw err;
            }
          }
        }

        if (totalWritten > 0) {
          state.totalFlushed += totalWritten;
          const filesUpdated = Array.from(filesSet);
          for (const listener of state.flushListeners) {
            try {
              listener(totalWritten, filesUpdated);
            } catch {
              // ignore
            }
          }
        }

        return {
          count: totalWritten,
          files: Array.from(filesSet),
          ...(lockTimedOut ? { lockTimedOut: true } : {}),
        };
      } finally {
        state.isFlushing = false;
        state.activeFlushPromise = null;
      }
    };

    let flushDone = false;
    let promise: Promise<FlushResult> | null = null;
    promise = (async () => {
      try {
        return await executeFlush();
      } finally {
        flushDone = true;
        state.isFlushing = false;
        if (state.activeFlushPromise === promise) {
          state.activeFlushPromise = null;
        }
      }
    })();
    if (!flushDone) {
      state.activeFlushPromise = promise;
    }
    return promise;
  }

  /**
   * Subscribe to real-time events (for UI monitoring)
   */
  public static subscribe(subscriber: EventSubscriber): () => void {
    const state = getState();
    state.subscribers.add(subscriber);
    return () => {
      state.subscribers.delete(subscriber);
    };
  }

  public static onFlush(callback: FlushCallback): () => void {
    const state = getState();
    state.flushListeners.add(callback);
    return () => {
      state.flushListeners.delete(callback);
    };
  }

  public static getLocalBufferSnapshot(limit?: number): DataEvent[] {
    const state = getState();
    if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) {
      const cap = Math.floor(limit);
      return cap === 0 ? [] : state.buffer.slice(-cap);
    }
    return [...state.buffer];
  }

  public static getRecentEvents(limit = 50, filterClientId?: string): DataEvent[] {
    const state = getState();
    if (filterClientId && filterClientId !== 'all') {
      return state.recentEvents
        .filter((e) => e.clientId === filterClientId)
        .slice(0, limit);
    }
    return state.recentEvents.slice(0, limit);
  }

  public static async getRecentEventsAsync(
    limit = 50,
    filterClientId?: string,
  ): Promise<DataEvent[]> {
    const state = getState();
    const redis = getRedisClient();

    if (redis) {
      try {
        const recentLimit = this.getRecentLimit();
        const readCap = Math.min(recentLimit, Math.max(limit * 4, limit));
        const rawItems = await redis.lrange(REDIS_RECENT_KEY, 0, readCap - 1);
        state.redisConnected = true;

        const redisEvents: DataEvent[] = [];
        for (const raw of rawItems) {
          try {
            const parsed = JSON.parse(raw) as DataEvent;
            if (!parsed || !parsed.eventId) continue;
            if (state.deletedClientIds.has(normalizeBufferClientId(parsed.clientId))) {
              continue;
            }
            if (filterClientId && filterClientId !== 'all' && parsed.clientId !== filterClientId) {
              continue;
            }
            redisEvents.push(parsed);
            if (redisEvents.length >= limit) break;
          } catch {
            // skip malformed JSON entry
          }
        }
        if (redisEvents.length > 0 || state.recentEvents.length === 0) {
          return redisEvents;
        }
      } catch {
        state.redisConnected = false;
      }
    }

    return this.getRecentEvents(limit, filterClientId);
  }

  public static getBufferStats() {
    const state = getState();
    return {
      currentBufferSize: state.buffer.length,
      localBufferSize: state.buffer.length,
      redisBufferSize: 0,
      redisEnabled: Boolean(getRedisClient()),
      redisConnected: state.redisConnected,
      batchFlushThreshold: state.batchFlushThreshold,
      batchFlushIntervalMs: state.batchFlushIntervalMs,
      totalIngested: state.totalIngested,
      totalFlushed: state.totalFlushed,
      recentEventsCached: state.recentEvents.length,
      activeSubscribers: state.subscribers.size,
      isFlushing: state.isFlushing,
    };
  }

  public static async getBufferStatsAsync() {
    const state = getState();
    const redis = getRedisClient();
    let redisBufferSize = 0;

    if (redis) {
      try {
        redisBufferSize = Number(await redis.llen(REDIS_BUFFER_KEY)) || 0;
        state.redisConnected = true;
      } catch {
        state.redisConnected = false;
        redisBufferSize = 0;
      }
    }

    return {
      currentBufferSize: state.buffer.length + redisBufferSize,
      localBufferSize: state.buffer.length,
      redisBufferSize,
      redisEnabled: Boolean(redis),
      redisConnected: state.redisConnected,
      batchFlushThreshold: state.batchFlushThreshold,
      batchFlushIntervalMs: state.batchFlushIntervalMs,
      totalIngested: state.totalIngested,
      totalFlushed: state.totalFlushed,
      recentEventsCached: state.recentEvents.length,
      activeSubscribers: state.subscribers.size,
      isFlushing: state.isFlushing,
    };
  }
}

// Auto-start timer
DataBufferEngine.init();

export default DataBufferEngine;
