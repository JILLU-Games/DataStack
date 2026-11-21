import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import zlib from 'node:zlib';
import { Parser } from 'json2csv';

export interface DataEvent {
  clientId: string;
  eventId: string;
  timestamp: string; // ISO 8601
  payload: string; // JSON stringified
}

export interface StorageFileMeta {
  clientId: string;
  date: string;
  filename: string;
  filePath: string;
  sizeBytes: number;
  linesCount: number;
  modifiedAt: Date;
  compressed?: boolean;
}

export interface DiskUsageSnapshot {
  available: boolean;
  usedPct: number;
  availableBytes: number;
  freeBytes: number;
  totalBytes: number;
  checkedAt: number;
}

export interface StorageAdmissionResult {
  allowed: boolean;
  code?: 'DISK_SPACE_LOW' | 'STORAGE_QUOTA_EXCEEDED';
  reason?: string;
}

export type StatfsProvider = (dir: string) => Promise<{
  blocks: number;
  bavail: number;
  bsize: number;
}>;

interface RowCountCacheEntry {
  sizeBytes: number;
  mtimeMs: number;
  linesCount: number;
}

const LOCK_RETRY_MIN_MS = 5;
const LOCK_RETRY_MAX_MS = 18;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_AGE_MS = 30_000;
const QUOTA_CACHE_TTL_MS = 30_000;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveDefaultStorageDir(): string {
  const configured = (process.env.DATASTACK_STORAGE_DIR || '').trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(process.cwd(), 'storage', 'data');
}

export class CSVStorageManager {
  // Base storage directory: DATASTACK_STORAGE_DIR or /storage/data
  public static baseStorageDir = resolveDefaultStorageDir();
  public static maxFileSizeBytes = 100 * 1024 * 1024; // 100MB rotation limit
  private static rowCountCache = new Map<string, RowCountCacheEntry>();
  private static diskUsageCache: DiskUsageSnapshot | null = null;
  private static clientBytesCache = new Map<
    string,
    { checkedAt: number; bytes: number }
  >();
  private static statfsOverrideForTests: StatfsProvider | null = null;

  public static isPartitionFilename(filename: string): boolean {
    return filename.endsWith('.csv') || filename.endsWith('.csv.gz');
  }

  public static extractDateFromFilename(filename: string): string {
    return String(filename || '')
      .replace(/\.csv(?:\.gz)?$/i, '')
      .replace(/(?:-(?:part|gz)\d+)+$/i, '');
  }

  public static clearRowCountCache(): void {
    this.rowCountCache.clear();
  }

  public static clearQuotaCaches(clientId?: string): void {
    this.diskUsageCache = null;
    if (clientId) {
      this.clientBytesCache.delete(this.sanitizeClientId(clientId));
    } else {
      this.clientBytesCache.clear();
    }
  }

  public static setStatfsOverrideForTests(provider: StatfsProvider | null): void {
    this.statfsOverrideForTests = provider;
    this.diskUsageCache = null;
  }

  public static sanitizeClientId(clientId: string): string {
    const raw = String(clientId || 'unknown').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    return raw || 'unknown';
  }

  /**
   * Checks whether the last byte of a non-empty file is LF (\n)
   */
  private static fileEndsWithNewline(filePath: string, sizeBytes: number): boolean {
    if (sizeBytes <= 0) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const lastByte = Buffer.allocUnsafe(1);
      const read = fs.readSync(fd, lastByte, 0, 1, sizeBytes - 1);
      return read === 1 && lastByte[0] === 0x0a;
    } finally {
      fs.closeSync(fd);
    }
  }

  private static removeStaleLockAtomically(lockPath: string): void {
    try {
      const lockStat = fs.lstatSync(lockPath);
      if (Date.now() - lockStat.mtimeMs <= STALE_LOCK_AGE_MS) {
        return;
      }
      const staleTmp = `${lockPath}.stale.${crypto.randomUUID()}`;
      fs.renameSync(lockPath, staleTmp);
      try {
        fs.unlinkSync(staleTmp);
      } catch {
        // Ignore cleanup failure of already-renamed stale token
      }
    } catch {
      // Lock was released or claimed concurrently
    }
  }

  private static releaseLockIfOwned(lockPath: string, lockValue: string): void {
    try {
      if (!fs.existsSync(lockPath)) return;
      const current = fs.readFileSync(lockPath, 'utf8');
      if (current === lockValue) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Ignore cleanup failure if already unlinked
    }
  }

  private static async removeStaleLockAtomicallyAsync(lockPath: string): Promise<void> {
    try {
      const lockStat = await fs.promises.lstat(lockPath);
      if (Date.now() - lockStat.mtimeMs <= STALE_LOCK_AGE_MS) {
        return;
      }
      const staleTmp = `${lockPath}.stale.${crypto.randomUUID()}`;
      await fs.promises.rename(lockPath, staleTmp);
      await fs.promises.unlink(staleTmp).catch(() => undefined);
    } catch {
      // Lock was released or claimed concurrently
    }
  }

  private static async releaseLockIfOwnedAsync(
    lockPath: string,
    lockValue: string,
  ): Promise<void> {
    try {
      const current = await fs.promises.readFile(lockPath, 'utf8');
      if (current === lockValue) {
        await fs.promises.unlink(lockPath);
      }
    } catch {
      // Ignore cleanup failure if already unlinked
    }
  }

  /**
   * Ensures client directory exists safely within baseStorageDir
   */
  public static ensureClientDir(clientId: string): string {
    const safeClientId = this.sanitizeClientId(clientId);
    const resolvedBase = path.resolve(this.baseStorageDir);
    const clientDir = path.resolve(resolvedBase, safeClientId);
    if (!clientDir.startsWith(resolvedBase + path.sep)) {
      throw new Error(`Invalid storage client directory: ${clientId}`);
    }
    if (!fs.existsSync(clientDir)) {
      fs.mkdirSync(clientDir, { recursive: true });
    }
    return clientDir;
  }

  /**
   * Acquires an exclusive cooperative lock file for a client+date partition across Port 3000 & Port 4000
   */
  public static async withPartitionLock<T>(
    clientId: string,
    dateStr: string,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const clientDir = this.ensureClientDir(clientId);
    const date = this.extractSafePartitionDate(dateStr);
    const lockPath = path.join(clientDir, `.${date}.csv.lock`);
    const lockValue = `${process.pid}:${Date.now()}:${crypto.randomUUID()}`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    let acquired = false;
    while (Date.now() < deadline) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        try {
          fs.writeFileSync(fd, lockValue, 'utf8');
        } finally {
          fs.closeSync(fd);
        }
        acquired = true;
        break;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'EEXIST') {
          throw err;
        }
        this.removeStaleLockAtomically(lockPath);
        const jitter =
          LOCK_RETRY_MIN_MS +
          Math.floor(Math.random() * (LOCK_RETRY_MAX_MS - LOCK_RETRY_MIN_MS));
        await sleepMs(jitter);
      }
    }

    if (!acquired) {
      throw new Error(`Timed out waiting for CSV partition lock: ${lockPath}`);
    }

    try {
      return await fn();
    } finally {
      this.releaseLockIfOwned(lockPath, lockValue);
    }
  }

  /**
   * Normalizes and validates any timestamp or date string into a strict YYYY-MM-DD partition key.
   * Returns fallback (default: today's date) if unparseable, or null when fallback is null.
   */
  public static extractSafePartitionDate(rawTimestamp?: string, fallback?: string): string;
  public static extractSafePartitionDate(rawTimestamp: string | undefined, fallback: null): string | null;
  public static extractSafePartitionDate(
    rawTimestamp?: string,
    fallback: string | null = new Date().toISOString().slice(0, 10),
  ): string | null {
    if (!rawTimestamp || typeof rawTimestamp !== 'string') {
      return fallback;
    }
    const trimmed = rawTimestamp.trim();
    const prefix = trimmed.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(prefix)) {
      const parsedPrefix = new Date(`${prefix}T00:00:00.000Z`);
      if (!Number.isNaN(parsedPrefix.getTime())) {
        return prefix;
      }
    }
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      const ms = num < 1e11 ? num * 1000 : num;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) {
        return d.toISOString().slice(0, 10);
      }
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
    return fallback;
  }

  /**
   * Stateful RFC 4180 quote-aware chunked row counter so multi-100MB CSVs never load wholly into RAM
   */
  private static createChunkRowCounter() {
    const decoder = new StringDecoder('utf8');
    let inQuotes = false;
    let pendingQuote = false;
    let currentLineHasChars = false;
    let totalRows = 0;

    const processStr = (str: string) => {
      for (let i = 0; i < str.length; i += 1) {
        const ch = str[i];
        if (pendingQuote) {
          pendingQuote = false;
          if (ch === '"') {
            // Escaped quote "" across chunk boundary or inline
            continue;
          }
          inQuotes = !inQuotes;
        }

        if (ch === '"') {
          currentLineHasChars = true;
          if (inQuotes) {
            if (i + 1 < str.length) {
              if (str[i + 1] === '"') {
                i += 1;
              } else {
                inQuotes = false;
              }
            } else {
              pendingQuote = true;
            }
          } else {
            inQuotes = true;
          }
        } else if (ch === '\n' && !inQuotes) {
          if (currentLineHasChars) {
            totalRows += 1;
            currentLineHasChars = false;
          }
        } else if (ch !== '\r' && ch !== ' ' && ch !== '\t') {
          currentLineHasChars = true;
        }
      }
    };

    return {
      pushChunk(chunk: Buffer | string) {
        const str = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        if (str) processStr(str);
      },
      finish(): number {
        const trailing = decoder.end();
        if (trailing) processStr(trailing);
        if (currentLineHasChars) {
          totalRows += 1;
        }
        return Math.max(0, totalRows - 1);
      },
    };
  }

  private static countCsvDataRowsChunkedSync(filePath: string): number {
    const counter = this.createChunkRowCounter();
    if (filePath.endsWith('.gz')) {
      const compressed = fs.readFileSync(filePath);
      const decompressed = zlib.gunzipSync(compressed);
      counter.pushChunk(decompressed);
      return counter.finish();
    }
    const buf = Buffer.allocUnsafe(64 * 1024);
    const fd = fs.openSync(filePath, 'r');
    try {
      let bytesRead = 0;
      while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        counter.pushChunk(buf.subarray(0, bytesRead));
      }
      return counter.finish();
    } finally {
      fs.closeSync(fd);
    }
  }

  public static openPartitionTextStream(filePath: string): Readable {
    const fileStream = fs.createReadStream(filePath, {
      highWaterMark: 64 * 1024,
    });
    if (!filePath.endsWith('.gz')) {
      return fileStream;
    }
    const gunzip = zlib.createGunzip();
    fileStream.on('error', (err) => {
      if (!gunzip.destroyed) {
        gunzip.destroy(err);
      }
      if (!fileStream.destroyed) {
        fileStream.destroy();
      }
    });
    gunzip.on('error', () => {
      if (!fileStream.destroyed) {
        fileStream.destroy();
      }
    });
    gunzip.on('close', () => {
      if (!fileStream.destroyed) {
        fileStream.destroy();
      }
    });
    fileStream.pipe(gunzip);
    return gunzip;
  }

  public static async countCsvDataRowsStreamAsync(
    filePath: string,
  ): Promise<number> {
    const counter = this.createChunkRowCounter();
    const stream = this.openPartitionTextStream(filePath);
    try {
      for await (const chunk of stream) {
        counter.pushChunk(chunk as Buffer | string);
      }
      return counter.finish();
    } finally {
      if (!stream.destroyed) {
        stream.destroy();
      }
    }
  }

  /**
   * Resolves target CSV file path with daily and configured MB rotation rules
   */
  public static getTargetFilePath(
    clientId: string,
    dateStr?: string,
    incomingBytes = 0,
  ): string {
    const clientDir = this.ensureClientDir(clientId);
    const date = this.extractSafePartitionDate(dateStr);
    let baseFileName = `${date}.csv`;
    let targetPath = path.join(clientDir, baseFileName);

    // Check for file rotation
    let partIndex = 1;
    while (fs.existsSync(targetPath)) {
      let stats: fs.Stats;
      try {
        stats = fs.statSync(targetPath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          break;
        }
        throw err;
      }
      const overflowsLimit =
        stats.size > 0 &&
        incomingBytes > 0 &&
        stats.size + incomingBytes > this.maxFileSizeBytes;
      if (stats.size >= this.maxFileSizeBytes || overflowsLimit) {
        partIndex += 1;
        baseFileName = `${date}-part${partIndex}.csv`;
        targetPath = path.join(clientDir, baseFileName);
      } else {
        break;
      }
    }

    return targetPath;
  }

  /**
   * Batch append events into target CSV file under cooperative partition lock.
   * If file doesn't exist, writes header: clientId,eventId,timestamp,payload
   */
  public static async appendBatch(
    events: DataEvent[],
  ): Promise<{ written: number; filesUpdated: string[] }> {
    if (!events || events.length === 0) {
      return { written: 0, filesUpdated: [] };
    }

    // Group events by client + date without ambiguous delimiter splitting
    const grouped = new Map<string, { clientId: string; date: string; events: DataEvent[] }>();
    for (const evt of events) {
      const date = this.extractSafePartitionDate(evt.timestamp);
      const clientId = String(evt.clientId || 'unknown');
      const key = JSON.stringify([clientId, date]);
      let bucket = grouped.get(key);
      if (!bucket) {
        bucket = { clientId, date, events: [] };
        grouped.set(key, bucket);
      }
      bucket.events.push(evt);
    }

    const filesUpdated: string[] = [];
    const fields = ['clientId', 'eventId', 'timestamp', 'payload'];

    for (const { clientId, date, events: batch } of grouped.values()) {
      const cleanBatch = batch.map((item) => ({
        clientId: item.clientId,
        eventId: item.eventId,
        timestamp: item.timestamp,
        payload:
          typeof item.payload === 'string'
            ? item.payload
            : JSON.stringify(item.payload),
      }));

      const bodyCsvNoHeader = new Parser({ fields, header: false, eol: '\n' }).parse(
        cleanBatch,
      );
      const incomingBytes = Buffer.byteLength(bodyCsvNoHeader, 'utf8') + 1;

      const targetPath = await this.withPartitionLock(clientId, date, () => {
        const resolvedPath = this.getTargetFilePath(clientId, date, incomingBytes);
        let sizeBytes = 0;
        try {
          if (fs.existsSync(resolvedPath)) {
            sizeBytes = fs.statSync(resolvedPath).size;
          }
        } catch {
          sizeBytes = 0;
        }
        const hasContent = sizeBytes > 0;

        if (hasContent) {
          const endsWithNl = this.fileEndsWithNewline(resolvedPath, sizeBytes);
          fs.appendFileSync(
            resolvedPath,
            (endsWithNl ? '' : '\n') + bodyCsvNoHeader,
            'utf8',
          );
        } else {
          const fullCsv = new Parser({ fields, header: true, eol: '\n' }).parse(
            cleanBatch,
          );
          fs.writeFileSync(resolvedPath, fullCsv, 'utf8');
        }

        // Invalidate row & quota caches for modified file immediately
        this.rowCountCache.delete(resolvedPath);
        this.clearQuotaCaches(clientId);
        return resolvedPath;
      });

      filesUpdated.push(targetPath);
    }

    return { written: events.length, filesUpdated };
  }

  /**
   * List all stored CSV and gzipped CSV (.csv / .csv.gz) files with cached row counts
   */
  public static listAllFiles(): StorageFileMeta[] {
    const results: StorageFileMeta[] = [];
    if (!fs.existsSync(this.baseStorageDir)) {
      this.rowCountCache.clear();
      return results;
    }

    const activePaths = new Set<string>();
    try {
      const clientDirs = fs.readdirSync(this.baseStorageDir);
      for (const clientDir of clientDirs) {
        const fullClientPath = path.join(this.baseStorageDir, clientDir);
        let dirLstat: fs.Stats;
        try {
          dirLstat = fs.lstatSync(fullClientPath);
        } catch {
          continue;
        }
        if (dirLstat.isSymbolicLink() || !dirLstat.isDirectory()) continue;

        const files = fs.readdirSync(fullClientPath);
        for (const file of files) {
          if (!this.isPartitionFilename(file)) continue;
          const fullFilePath = path.join(fullClientPath, file);
          let stats: fs.Stats;
          try {
            stats = fs.lstatSync(fullFilePath);
          } catch {
            continue;
          }
          if (stats.isSymbolicLink() || !stats.isFile()) continue;
          activePaths.add(fullFilePath);

          const cached = this.rowCountCache.get(fullFilePath);
          let linesCount = 0;
          if (
            cached &&
            cached.sizeBytes === stats.size &&
            cached.mtimeMs === stats.mtimeMs
          ) {
            linesCount = cached.linesCount;
          } else {
            try {
              linesCount = this.countCsvDataRowsChunkedSync(fullFilePath);
              this.rowCountCache.set(fullFilePath, {
                sizeBytes: stats.size,
                mtimeMs: stats.mtimeMs,
                linesCount,
              });
            } catch {
              linesCount = 0;
            }
          }

          const datePart = this.extractDateFromFilename(file);

          results.push({
            clientId: clientDir,
            date: datePart,
            filename: file,
            filePath: fullFilePath,
            sizeBytes: stats.size,
            linesCount,
            modifiedAt: stats.mtime,
            compressed: file.endsWith('.csv.gz'),
          });
        }
      }

      for (const key of this.rowCountCache.keys()) {
        if (!activePaths.has(key)) {
          this.rowCountCache.delete(key);
        }
      }
    } catch {
      // Return whatever collected
    }

    return results.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  }

  /**
   * Non-blocking async listing using fs.promises + streaming row counting on cache misses
   */
  public static async listAllFilesAsync(): Promise<StorageFileMeta[]> {
    const results: StorageFileMeta[] = [];
    if (!fs.existsSync(this.baseStorageDir)) {
      this.rowCountCache.clear();
      return results;
    }

    const activePaths = new Set<string>();
    try {
      const clientDirs = await fs.promises.readdir(this.baseStorageDir);
      for (const clientDir of clientDirs) {
        const fullClientPath = path.join(this.baseStorageDir, clientDir);
        const dirLstat = await fs.promises.lstat(fullClientPath).catch(() => null);
        if (!dirLstat || dirLstat.isSymbolicLink() || !dirLstat.isDirectory()) continue;

        const files = await fs.promises.readdir(fullClientPath);
        for (const file of files) {
          if (!this.isPartitionFilename(file)) continue;
          const fullFilePath = path.join(fullClientPath, file);
          const stats = await fs.promises.lstat(fullFilePath).catch(() => null);
          if (!stats || stats.isSymbolicLink() || !stats.isFile()) continue;
          activePaths.add(fullFilePath);

          const cached = this.rowCountCache.get(fullFilePath);
          let linesCount = 0;
          if (
            cached &&
            cached.sizeBytes === stats.size &&
            cached.mtimeMs === stats.mtimeMs
          ) {
            linesCount = cached.linesCount;
          } else {
            try {
              linesCount = await this.countCsvDataRowsStreamAsync(fullFilePath);
              this.rowCountCache.set(fullFilePath, {
                sizeBytes: stats.size,
                mtimeMs: stats.mtimeMs,
                linesCount,
              });
            } catch {
              linesCount = 0;
            }
          }

          const datePart = this.extractDateFromFilename(file);

          results.push({
            clientId: clientDir,
            date: datePart,
            filename: file,
            filePath: fullFilePath,
            sizeBytes: stats.size,
            linesCount,
            modifiedAt: stats.mtime,
            compressed: file.endsWith('.csv.gz'),
          });
        }
      }

      for (const key of this.rowCountCache.keys()) {
        if (!activePaths.has(key)) {
          this.rowCountCache.delete(key);
        }
      }
    } catch {
      // Return whatever collected
    }

    return results.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  }

  /**
   * Compress uncompressed .csv partitions older than compressAfterDays into .csv.gz under cooperative partition locks
   */
  public static async compressOldPartitionsAsync(
    compressAfterDays: number,
  ): Promise<number> {
    if (!Number.isFinite(compressAfterDays) || compressAfterDays <= 0) {
      return 0;
    }

    const baseStat = await fs.promises.lstat(this.baseStorageDir).catch(() => null);
    if (!baseStat || !baseStat.isDirectory()) {
      return 0;
    }

    const cutoffDate = new Date(
      Date.now() - Math.floor(compressAfterDays) * 86_400_000,
    )
      .toISOString()
      .split('T')[0];

    let compressedCount = 0;
    try {
      const clientDirs = await fs.promises.readdir(this.baseStorageDir);
      for (const clientDir of clientDirs) {
        const fullClientPath = path.join(this.baseStorageDir, clientDir);
        const dirLstat = await fs.promises.lstat(fullClientPath).catch(() => null);
        if (!dirLstat || dirLstat.isSymbolicLink() || !dirLstat.isDirectory()) {
          continue;
        }

        const files = await fs.promises
          .readdir(fullClientPath)
          .catch(() => [] as string[]);
        for (const file of files) {
          if (!file.endsWith('.csv')) continue;
          const datePart = this.extractDateFromFilename(file);
          if (!(/^\d{4}-\d{2}-\d{2}$/.test(datePart) && datePart < cutoffDate)) {
            continue;
          }
          const fullPath = path.join(fullClientPath, file);
          const fileLstat = await fs.promises.lstat(fullPath).catch(() => null);
          if (!fileLstat || fileLstat.isSymbolicLink() || !fileLstat.isFile()) {
            continue;
          }

          const lockPath = path.join(fullClientPath, `.${datePart}.csv.lock`);
          const lockValue = `${process.pid}:${Date.now()}:${crypto.randomUUID()}`;
          let acquired = false;
          const tryAcquireLock = async (): Promise<boolean> => {
            const handle = await fs.promises.open(lockPath, 'wx');
            try {
              await handle.writeFile(lockValue, 'utf8');
            } finally {
              await handle.close();
            }
            return true;
          };

          try {
            acquired = await tryAcquireLock();
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
              await this.removeStaleLockAtomicallyAsync(lockPath);
              try {
                acquired = await tryAcquireLock();
              } catch {
                acquired = false;
              }
            }
          }

          if (!acquired) continue;

          let targetGzPath = `${fullPath}.gz`;
          if (fs.existsSync(targetGzPath)) {
            const stem = fullPath.replace(/\.csv$/, '');
            let suffix = 2;
            while (fs.existsSync(`${stem}-gz${suffix}.csv.gz`)) {
              suffix += 1;
            }
            targetGzPath = `${stem}-gz${suffix}.csv.gz`;
          }
          const tmpGzPath = `${targetGzPath}.tmp.${crypto.randomUUID()}`;

          try {
            await pipeline(
              fs.createReadStream(fullPath, { highWaterMark: 64 * 1024 }),
              zlib.createGzip({ level: 6 }),
              fs.createWriteStream(tmpGzPath),
            );
            await fs.promises
              .utimes(tmpGzPath, fileLstat.atime, fileLstat.mtime)
              .catch(() => undefined);
            await fs.promises.rename(tmpGzPath, targetGzPath);
            await fs.promises.unlink(fullPath);
            this.rowCountCache.delete(fullPath);
            this.rowCountCache.delete(targetGzPath);
            this.clearQuotaCaches(clientDir);
            compressedCount += 1;
          } catch {
            await fs.promises.unlink(tmpGzPath).catch(() => undefined);
          } finally {
            await this.releaseLockIfOwnedAsync(lockPath, lockValue);
          }
        }
      }
    } catch {
      // Ignore directory scan failure
    }

    return compressedCount;
  }

  /**
   * Prune CSV / CSV.GZ partitions older than autoPruneDays under cooperative partition locks
   */
  public static pruneExpiredPartitions(autoPruneDays: number): number {
    if (!Number.isFinite(autoPruneDays) || autoPruneDays <= 0) {
      return 0;
    }
    if (!fs.existsSync(this.baseStorageDir)) {
      return 0;
    }

    const cutoffDate = new Date(
      Date.now() - Math.floor(autoPruneDays) * 86_400_000,
    )
      .toISOString()
      .split('T')[0];

    let prunedCount = 0;
    try {
      const clientDirs = fs.readdirSync(this.baseStorageDir);
      for (const clientDir of clientDirs) {
        const fullClientPath = path.join(this.baseStorageDir, clientDir);
        let dirLstat: fs.Stats;
        try {
          dirLstat = fs.lstatSync(fullClientPath);
        } catch {
          continue;
        }
        if (dirLstat.isSymbolicLink() || !dirLstat.isDirectory()) continue;

        const files = fs.readdirSync(fullClientPath);
        for (const file of files) {
          if (!this.isPartitionFilename(file)) continue;
          const datePart = this.extractDateFromFilename(file);
          if (/^\d{4}-\d{2}-\d{2}$/.test(datePart) && datePart < cutoffDate) {
            const fullPath = path.join(fullClientPath, file);
            let fileLstat: fs.Stats;
            try {
              fileLstat = fs.lstatSync(fullPath);
            } catch {
              continue;
            }
            if (fileLstat.isSymbolicLink() || !fileLstat.isFile()) continue;

            const lockPath = path.join(fullClientPath, `.${datePart}.csv.lock`);
            const lockValue = `${process.pid}:${Date.now()}:${crypto.randomUUID()}`;
            let acquired = false;
            try {
              const fd = fs.openSync(lockPath, 'wx');
              try {
                fs.writeFileSync(fd, lockValue, 'utf8');
              } finally {
                fs.closeSync(fd);
              }
              acquired = true;
            } catch (err: unknown) {
              if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
                this.removeStaleLockAtomically(lockPath);
                try {
                  const fd = fs.openSync(lockPath, 'wx');
                  try {
                    fs.writeFileSync(fd, lockValue, 'utf8');
                  } finally {
                    fs.closeSync(fd);
                  }
                  acquired = true;
                } catch {
                  // Partition is currently locked by an active writer; skip safely
                  acquired = false;
                }
              }
            }

            if (!acquired) continue;

            try {
              if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
                this.rowCountCache.delete(fullPath);
                this.clearQuotaCaches(clientDir);
                prunedCount += 1;
              }
            } catch {
              // Ignore file removal error
            } finally {
              this.releaseLockIfOwned(lockPath, lockValue);
            }
          }
        }
      }
    } catch {
      // Ignore directory scan failure
    }

    return prunedCount;
  }

  /**
   * Archive and/or prune expired partitions under cooperative partition locks.
   * Never deletes a local partition if options.beforeDeleteFile throws or rejects (V2-E02).
   */
  public static async pruneOrArchiveExpiredPartitionsAsync(
    autoPruneDays: number,
    options?: {
      beforeDeleteFile?: (file: {
        clientId: string;
        filename: string;
        filePath: string;
        date: string;
      }) => Promise<void>;
      archiveOnlyWithoutDelete?: boolean;
      maxCutoffDays?: number;
    },
  ): Promise<{
    scannedCount: number;
    archivedCount: number;
    prunedCount: number;
    errors: string[];
  }> {
    const targetDays =
      options?.maxCutoffDays !== undefined
        ? options.maxCutoffDays
        : autoPruneDays;
    if (!Number.isFinite(targetDays) || targetDays < 0) {
      return { scannedCount: 0, archivedCount: 0, prunedCount: 0, errors: [] };
    }
    if (options?.maxCutoffDays === undefined && targetDays <= 0) {
      return { scannedCount: 0, archivedCount: 0, prunedCount: 0, errors: [] };
    }

    const baseStat = await fs.promises.lstat(this.baseStorageDir).catch(() => null);
    if (!baseStat || !baseStat.isDirectory()) {
      return { scannedCount: 0, archivedCount: 0, prunedCount: 0, errors: [] };
    }

    const cutoffDate = new Date(
      Date.now() - Math.floor(targetDays) * 86_400_000,
    )
      .toISOString()
      .split('T')[0];

    let scannedCount = 0;
    let archivedCount = 0;
    let prunedCount = 0;
    const errors: string[] = [];

    try {
      const clientDirs = await fs.promises.readdir(this.baseStorageDir);
      for (const clientDir of clientDirs) {
        const fullClientPath = path.join(this.baseStorageDir, clientDir);
        const dirLstat = await fs.promises.lstat(fullClientPath).catch(() => null);
        if (!dirLstat || dirLstat.isSymbolicLink() || !dirLstat.isDirectory()) {
          continue;
        }

        const files = await fs.promises
          .readdir(fullClientPath)
          .catch(() => [] as string[]);
        for (const file of files) {
          if (!this.isPartitionFilename(file)) continue;
          const datePart = this.extractDateFromFilename(file);
          if (!(/^\d{4}-\d{2}-\d{2}$/.test(datePart) && datePart < cutoffDate)) {
            continue;
          }
          const fullPath = path.join(fullClientPath, file);
          const fileLstat = await fs.promises.lstat(fullPath).catch(() => null);
          if (!fileLstat || fileLstat.isSymbolicLink() || !fileLstat.isFile()) {
            continue;
          }
          scannedCount += 1;

          const lockPath = path.join(fullClientPath, `.${datePart}.csv.lock`);
          const lockValue = `${process.pid}:${Date.now()}:${crypto.randomUUID()}`;
          let acquired = false;
          const tryAcquireLock = async (): Promise<boolean> => {
            const handle = await fs.promises.open(lockPath, 'wx');
            try {
              await handle.writeFile(lockValue, 'utf8');
            } finally {
              await handle.close();
            }
            return true;
          };

          try {
            acquired = await tryAcquireLock();
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
              await this.removeStaleLockAtomicallyAsync(lockPath);
              try {
                acquired = await tryAcquireLock();
              } catch {
                acquired = false;
              }
            }
          }

          if (!acquired) continue;

          try {
            if (options?.beforeDeleteFile) {
              await options.beforeDeleteFile({
                clientId: clientDir,
                filename: file,
                filePath: fullPath,
                date: datePart,
              });
              archivedCount += 1;
            }
            if (!options?.archiveOnlyWithoutDelete) {
              await fs.promises.unlink(fullPath);
              this.rowCountCache.delete(fullPath);
              this.clearQuotaCaches(clientDir);
              prunedCount += 1;
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Archive/prune error';
            errors.push(`${clientDir}/${file}: ${msg}`);
          } finally {
            await this.releaseLockIfOwnedAsync(lockPath, lockValue);
          }
        }
      }
    } catch {
      // Ignore directory scan failure
    }

    return { scannedCount, archivedCount, prunedCount, errors };
  }

  /**
   * Non-blocking async partition pruner using fs.promises under cooperative partition locks
   */
  public static async pruneExpiredPartitionsAsync(
    autoPruneDays: number,
  ): Promise<number> {
    const res = await this.pruneOrArchiveExpiredPartitionsAsync(autoPruneDays);
    return res.prunedCount;
  }

  /**
   * Cached VPS filesystem disk usage snapshot (30s TTL) for disk-full protection
   */
  public static async getDiskUsageAsync(): Promise<DiskUsageSnapshot> {
    const now = Date.now();
    if (
      this.diskUsageCache &&
      now - this.diskUsageCache.checkedAt < QUOTA_CACHE_TTL_MS
    ) {
      return this.diskUsageCache;
    }

    let probeDir = path.resolve(this.baseStorageDir);
    while (!fs.existsSync(probeDir)) {
      const parent = path.dirname(probeDir);
      if (parent === probeDir) break;
      probeDir = parent;
    }

    try {
      const statfsRes = this.statfsOverrideForTests
        ? await this.statfsOverrideForTests(probeDir)
        : await fs.promises.statfs(probeDir);
      const bsize = Math.max(1, Number(statfsRes.bsize) || 4096);
      const totalBytes = Math.max(0, Number(statfsRes.blocks) * bsize);
      const availableBytes = Math.max(0, Number(statfsRes.bavail) * bsize);
      const usedBytes = Math.max(0, totalBytes - availableBytes);
      const usedPct =
        totalBytes > 0
          ? Number(
              Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100)).toFixed(2),
            )
          : 0;
      const snapshot: DiskUsageSnapshot = {
        available: totalBytes > 0,
        usedPct,
        availableBytes,
        freeBytes: availableBytes,
        totalBytes,
        checkedAt: now,
      };
      this.diskUsageCache = snapshot;
      return snapshot;
    } catch {
      const fallback: DiskUsageSnapshot = {
        available: false,
        usedPct: 0,
        availableBytes: 0,
        freeBytes: 0,
        totalBytes: 0,
        checkedAt: now,
      };
      this.diskUsageCache = fallback;
      return fallback;
    }
  }

  /**
   * Cached per-client directory byte count (30s TTL)
   */
  public static async getClientStorageBytesAsync(
    clientId: string,
  ): Promise<number> {
    const safeClientId = this.sanitizeClientId(clientId);
    const now = Date.now();
    const cached = this.clientBytesCache.get(safeClientId);
    if (cached && now - cached.checkedAt < QUOTA_CACHE_TTL_MS) {
      return cached.bytes;
    }

    const resolvedBase = path.resolve(this.baseStorageDir);
    const clientDir = path.resolve(resolvedBase, safeClientId);
    if (!clientDir.startsWith(resolvedBase + path.sep)) {
      return 0;
    }

    let totalBytes = 0;
    try {
      const dirStat = await fs.promises.lstat(clientDir).catch(() => null);
      if (dirStat && !dirStat.isSymbolicLink() && dirStat.isDirectory()) {
        const entries = await fs.promises
          .readdir(clientDir)
          .catch(() => [] as string[]);
        for (const entry of entries) {
          if (!this.isPartitionFilename(entry)) continue;
          const filePath = path.join(clientDir, entry);
          const stats = await fs.promises.lstat(filePath).catch(() => null);
          if (stats && !stats.isSymbolicLink() && stats.isFile()) {
            totalBytes += stats.size;
          }
        }
      }
    } catch {
      // Fall back to 0 on unreadable directory
    }

    this.clientBytesCache.set(safeClientId, { checkedAt: now, bytes: totalBytes });
    return totalBytes;
  }

  /**
   * Checks global VPS disk threshold and per-client MB quota before admitting new events
   */
  public static async checkStorageAdmissionAsync(
    clientId: string,
    clientQuotaMb: number,
    diskPauseThresholdPct: number,
  ): Promise<StorageAdmissionResult> {
    const threshold = Number(diskPauseThresholdPct);
    if (Number.isFinite(threshold) && threshold >= 50 && threshold <= 99) {
      const disk = await this.getDiskUsageAsync();
      if (disk.totalBytes > 0 && disk.usedPct >= threshold) {
        return {
          allowed: false,
          code: 'DISK_SPACE_LOW',
          reason: `DISK_SPACE_LOW: Disk utilization (${disk.usedPct.toFixed(1)}%) reached safety pause threshold (${threshold}%).`,
        };
      }
    }

    const quotaMb = Number(clientQuotaMb);
    if (Number.isFinite(quotaMb) && quotaMb > 0) {
      const currentBytes = await this.getClientStorageBytesAsync(clientId);
      const quotaBytes = Math.floor(quotaMb) * 1024 * 1024;
      if (currentBytes >= quotaBytes) {
        return {
          allowed: false,
          code: 'STORAGE_QUOTA_EXCEEDED',
          reason: `STORAGE_QUOTA_EXCEEDED: Client '${clientId}' used ${(currentBytes / (1024 * 1024)).toFixed(2)} MB of ${quotaMb} MB quota.`,
        };
      }
    }

    return { allowed: true };
  }

  public static formatStorageStats(files: StorageFileMeta[]) {
    const totalBytes = files.reduce((acc, f) => acc + f.sizeBytes, 0);
    const totalRows = files.reduce((acc, f) => acc + f.linesCount, 0);
    const uniqueClients = new Set(files.map((f) => f.clientId)).size;
    const rotationMb = Math.max(
      1,
      Math.round(this.maxFileSizeBytes / (1024 * 1024)),
    );

    return {
      totalFiles: files.length,
      totalBytes,
      totalMB: (totalBytes / (1024 * 1024)).toFixed(2),
      totalRows,
      uniqueClients,
      storageDirectory: this.baseStorageDir,
      rotationMb,
      rotationRule: `${rotationMb}MB / Daily`,
    };
  }

  /**
   * Get aggregate storage statistics (sync cached)
   */
  public static getStorageStats() {
    return this.formatStorageStats(this.listAllFiles());
  }

  /**
   * Get aggregate storage statistics (non-blocking async)
   */
  public static async getStorageStatsAsync() {
    const files = await this.listAllFilesAsync();
    return this.formatStorageStats(files);
  }

  /**
   * Reads file content for export / download with path traversal protection (supports .csv & .csv.gz)
   */
  public static getFileContent(clientId: string, filename: string): string | null {
    const safeClientId = this.sanitizeClientId(clientId);
    const safeFilename = path.basename(String(filename || ''));
    if (!safeClientId || !safeFilename || !this.isPartitionFilename(safeFilename)) {
      return null;
    }
    const resolvedBase = path.resolve(this.baseStorageDir);
    const fullPath = path.resolve(resolvedBase, safeClientId, safeFilename);
    if (!fullPath.startsWith(resolvedBase + path.sep)) {
      return null;
    }
    if (fs.existsSync(fullPath)) {
      const stats = fs.lstatSync(fullPath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        return null;
      }
      if (safeFilename.endsWith('.gz')) {
        return zlib.gunzipSync(fs.readFileSync(fullPath)).toString('utf8');
      }
      return fs.readFileSync(fullPath, 'utf8');
    }
    return null;
  }
}

export default CSVStorageManager;
