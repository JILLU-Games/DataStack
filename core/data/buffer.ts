import crypto from 'node:crypto';
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
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  quit?: () => Promise<unknown>;
  disconnect?: () => void;
}

export const REDIS_BUFFER_KEY = 'datastack:buffer:events';
export const REDIS_RECENT_KEY = 'datastack:recent:events';
export const REDIS_FLUSH_LOCK_KEY = 'datastack:flush:lock';
const REDIS_RECENT_LIMIT = 500;
const FLUSH_LOCK_TTL_MS = 15000;
const UNLOCK_LUA_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

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
  redisClient: RedisBufferClient | null | undefined;
  redisUrlConfigured: string;
  redisConnected: boolean;
  redisTestOverride: RedisBufferClient | null | undefined;
  pendingRedisWrites: Set<Promise<void>>;
}

type BufferGlobals = typeof globalThis & {
  __dataStackBufferState?: BufferGlobalState;
  __dataStackBufferShutdownRegistered?: boolean;
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
      redisClient: undefined,
      redisUrlConfigured: '',
      redisConnected: false,
      redisTestOverride: undefined,
      pendingRedisWrites: new Set(),
    };
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
  private static maxRecentEvents = REDIS_RECENT_LIMIT;

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

  public static init() {
    const state = getState();
    if (!state.flushTimer) {
      state.flushTimer = setInterval(() => {
        void this.flush().catch(() => undefined);
      }, state.batchFlushIntervalMs);
    }

    if (
      typeof process !== 'undefined' &&
      typeof process.on === 'function' &&
      !globals.__dataStackBufferShutdownRegistered
    ) {
      globals.__dataStackBufferShutdownRegistered = true;
      const flushOnExit = () => {
        void this.flush().catch(() => undefined);
      };
      process.on('SIGTERM', flushOnExit);
      process.on('SIGINT', flushOnExit);
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
    if (state.recentEvents.length > this.maxRecentEvents) {
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
      try {
        const bufferLen = await redis.rpush(REDIS_BUFFER_KEY, ...serialized);
        await redis.lpush(REDIS_RECENT_KEY, ...serialized);
        await redis.ltrim(REDIS_RECENT_KEY, 0, REDIS_RECENT_LIMIT - 1);
        state.redisConnected = true;
        return Number(bufferLen) + state.buffer.length;
      } catch {
        state.redisConnected = false;
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

  /**
   * Flushes queued events (shared Redis list under distributed lock + local RAM fallback) to partitioned CSV files.
   * Redis LTRIM runs ONLY after CSVStorageManager.appendBatch succeeds so crashes never lose data.
   */
  public static async flush(): Promise<{ count: number; files: string[] }> {
    const state = getState();
    if (state.pendingRedisWrites.size > 0) {
      await Promise.allSettled([...state.pendingRedisWrites]);
    }
    if (state.isFlushing) {
      return { count: 0, files: [] };
    }

    state.isFlushing = true;
    let totalWritten = 0;
    const filesSet = new Set<string>();

    try {
      const redis = getRedisClient();
      if (redis) {
        const lockToken = crypto.randomUUID();
        let lockAcquired = false;

        try {
          const lockResult = await redis.set(
            REDIS_FLUSH_LOCK_KEY,
            lockToken,
            'PX',
            FLUSH_LOCK_TTL_MS,
            'NX',
          );
          lockAcquired = lockResult === 'OK';
          state.redisConnected = true;
        } catch {
          state.redisConnected = false;
          lockAcquired = false;
        }

        if (lockAcquired) {
          try {
            const chunkSize = Math.max(500, state.batchFlushThreshold);
            while (true) {
              const rawItems = await redis.lrange(REDIS_BUFFER_KEY, 0, chunkSize - 1);
              if (!rawItems || rawItems.length === 0) {
                break;
              }

              const parsedBatch: DataEvent[] = [];
              for (const raw of rawItems) {
                try {
                  const evt = JSON.parse(raw) as DataEvent;
                  if (evt && evt.eventId) {
                    parsedBatch.push(evt);
                  }
                } catch {
                  // Ignore malformed legacy entry while still trimming it
                }
              }

              if (parsedBatch.length > 0) {
                const res = await CSVStorageManager.appendBatch(parsedBatch);
                totalWritten += res.written;
                for (const f of res.filesUpdated) filesSet.add(f);
              }

              // Trim strictly AFTER CSVStorageManager.appendBatch resolves safely
              await redis.ltrim(REDIS_BUFFER_KEY, rawItems.length, -1);

              if (rawItems.length < chunkSize) {
                break;
              }
            }
          } finally {
            try {
              await redis.eval(UNLOCK_LUA_SCRIPT, 1, REDIS_FLUSH_LOCK_KEY, lockToken);
            } catch {
              // Lock auto-expires after FLUSH_LOCK_TTL_MS
            }
          }
        }
      }

      if (state.buffer.length > 0) {
        const ramBatch = [...state.buffer];
        state.buffer = [];
        try {
          const res = await CSVStorageManager.appendBatch(ramBatch);
          totalWritten += res.written;
          for (const f of res.filesUpdated) filesSet.add(f);
        } catch (err) {
          state.buffer.unshift(...ramBatch);
          throw err;
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

      return { count: totalWritten, files: Array.from(filesSet) };
    } finally {
      state.isFlushing = false;
    }
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
        const readCap = Math.min(REDIS_RECENT_LIMIT, Math.max(limit * 4, limit));
        const rawItems = await redis.lrange(REDIS_RECENT_KEY, 0, readCap - 1);
        state.redisConnected = true;

        const redisEvents: DataEvent[] = [];
        for (const raw of rawItems) {
          try {
            const parsed = JSON.parse(raw) as DataEvent;
            if (!parsed || !parsed.eventId) continue;
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
