import { CSVStorageManager, DataEvent } from '../Storage/csvStorage';

export type EventSubscriber = (event: DataEvent) => void;
export type FlushCallback = (count: number, files: string[]) => void;

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
    };
  }
  return globals.__dataStackBufferState;
}

export class DataBufferEngine {
  private static maxRecentEvents = 200;

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

  public static init() {
    const state = getState();
    if (!state.flushTimer) {
      state.flushTimer = setInterval(() => {
        void this.flush();
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
      void this.flush();
    }, state.batchFlushIntervalMs);
  }

  /**
   * Push incoming event to in-memory buffer.
   * If buffer hits threshold (e.g. 500 rows), triggers immediate batch flush.
   */
  public static push(event: DataEvent): void {
    const state = getState();
    state.buffer.push(event);
    state.totalIngested += 1;

    // Cache in recent events for live dashboard viewer
    state.recentEvents.unshift(event);
    if (state.recentEvents.length > this.maxRecentEvents) {
      state.recentEvents.pop();
    }

    // Notify live subscribers
    for (const sub of state.subscribers) {
      try {
        sub(event);
      } catch {
        // Ignore subscriber error
      }
    }

    // Check if buffer threshold reached
    if (state.buffer.length >= state.batchFlushThreshold) {
      void this.flush();
    }
  }

  /**
   * Flushes current buffer to CSV files via CSVStorageManager
   */
  public static async flush(): Promise<{ count: number; files: string[] }> {
    const state = getState();
    if (state.buffer.length === 0 || state.isFlushing) {
      return { count: 0, files: [] };
    }

    state.isFlushing = true;
    const batchToFlush = [...state.buffer];
    state.buffer = [];

    try {
      const result = await CSVStorageManager.appendBatch(batchToFlush);
      state.totalFlushed += result.written;

      for (const listener of state.flushListeners) {
        try {
          listener(result.written, result.filesUpdated);
        } catch {
          // ignore
        }
      }

      return { count: result.written, files: result.filesUpdated };
    } catch (err) {
      // On failure, re-queue to buffer front for retry
      state.buffer.unshift(...batchToFlush);
      throw err;
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

  public static getBufferStats() {
    const state = getState();
    return {
      currentBufferSize: state.buffer.length,
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
