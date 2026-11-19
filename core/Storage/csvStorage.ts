import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { StringDecoder } from 'node:string_decoder';
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
}

interface RowCountCacheEntry {
  sizeBytes: number;
  mtimeMs: number;
  linesCount: number;
}

const LOCK_RETRY_MIN_MS = 5;
const LOCK_RETRY_MAX_MS = 18;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_AGE_MS = 30_000;

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

  public static clearRowCountCache(): void {
    this.rowCountCache.clear();
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

  private static async countCsvDataRowsStreamAsync(
    filePath: string,
  ): Promise<number> {
    const counter = this.createChunkRowCounter();
    return new Promise<number>((resolve, reject) => {
      const stream = fs.createReadStream(filePath, {
        highWaterMark: 64 * 1024,
      });
      stream.on('data', (chunk) => counter.pushChunk(chunk));
      stream.on('end', () => resolve(counter.finish()));
      stream.on('error', (err) => reject(err));
    });
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

        // Invalidate row cache for modified file immediately
        this.rowCountCache.delete(resolvedPath);
        return resolvedPath;
      });

      filesUpdated.push(targetPath);
    }

    return { written: events.length, filesUpdated };
  }

  /**
   * List all stored CSV files with cached row counts (invalidated on mtime/size changes)
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
          if (!file.endsWith('.csv')) continue;
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

          const datePart = file.replace('.csv', '').split('-part')[0];

          results.push({
            clientId: clientDir,
            date: datePart,
            filename: file,
            filePath: fullFilePath,
            sizeBytes: stats.size,
            linesCount,
            modifiedAt: stats.mtime,
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
          if (!file.endsWith('.csv')) continue;
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

          const datePart = file.replace('.csv', '').split('-part')[0];

          results.push({
            clientId: clientDir,
            date: datePart,
            filename: file,
            filePath: fullFilePath,
            sizeBytes: stats.size,
            linesCount,
            modifiedAt: stats.mtime,
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
   * Prune CSV partitions older than autoPruneDays under cooperative partition locks
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
          if (!file.endsWith('.csv')) continue;
          const datePart = file.replace('.csv', '').split('-part')[0];
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
   * Non-blocking async partition pruner using fs.promises under cooperative partition locks
   */
  public static async pruneExpiredPartitionsAsync(
    autoPruneDays: number,
  ): Promise<number> {
    if (!Number.isFinite(autoPruneDays) || autoPruneDays <= 0) {
      return 0;
    }

    const baseStat = await fs.promises.lstat(this.baseStorageDir).catch(() => null);
    if (!baseStat || !baseStat.isDirectory()) {
      return 0;
    }

    const cutoffDate = new Date(
      Date.now() - Math.floor(autoPruneDays) * 86_400_000,
    )
      .toISOString()
      .split('T')[0];

    let prunedCount = 0;
    try {
      const clientDirs = await fs.promises.readdir(this.baseStorageDir);
      for (const clientDir of clientDirs) {
        const fullClientPath = path.join(this.baseStorageDir, clientDir);
        const dirLstat = await fs.promises.lstat(fullClientPath).catch(() => null);
        if (!dirLstat || dirLstat.isSymbolicLink() || !dirLstat.isDirectory()) {
          continue;
        }

        const files = await fs.promises.readdir(fullClientPath).catch(() => [] as string[]);
        for (const file of files) {
          if (!file.endsWith('.csv')) continue;
          const datePart = file.replace('.csv', '').split('-part')[0];
          if (/^\d{4}-\d{2}-\d{2}$/.test(datePart) && datePart < cutoffDate) {
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

            try {
              await fs.promises.unlink(fullPath);
              this.rowCountCache.delete(fullPath);
              prunedCount += 1;
            } catch {
              // Ignore individual unlink error or concurrent removal
            } finally {
              await this.releaseLockIfOwnedAsync(lockPath, lockValue);
            }
          }
        }
      }
    } catch {
      // Ignore directory scan failure
    }

    return prunedCount;
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
   * Reads file content for export / download with path traversal protection
   */
  public static getFileContent(clientId: string, filename: string): string | null {
    const safeClientId = this.sanitizeClientId(clientId);
    const safeFilename = path.basename(String(filename || ''));
    if (!safeClientId || !safeFilename || !safeFilename.endsWith('.csv')) {
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
      return fs.readFileSync(fullPath, 'utf8');
    }
    return null;
  }
}

export default CSVStorageManager;
