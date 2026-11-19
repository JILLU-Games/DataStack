const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { Parser } = require('json2csv');

const LOCK_RETRY_MIN_MS = 5;
const LOCK_RETRY_MAX_MS = 18;
const LOCK_TIMEOUT_MS = 10000;
const STALE_LOCK_AGE_MS = 30000;

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveDefaultStorageDir() {
  const configured = (process.env.DATASTACK_STORAGE_DIR || '').trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(__dirname, '../../storage/data');
}

/**
 * Background CSV Writer Worker
 * Flushes batches of real-time events to partitioned CSV files.
 * Path convention: /storage/data/{clientId}/{YYYY-MM-DD}.csv
 */
class CsvWriterWorker {
  constructor(baseDir = resolveDefaultStorageDir(), maxFileSize = 100 * 1024 * 1024) {
    this.baseDir = baseDir;
    this.maxFileSize = maxFileSize;
    this.ensureBaseDir();
  }

  setMaxFileSizeMb(megabytes) {
    const mb = Number(megabytes);
    if (Number.isFinite(mb) && mb >= 1) {
      this.maxFileSize = Math.floor(mb * 1024 * 1024);
    }
  }

  ensureBaseDir() {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  sanitizeClientId(clientId) {
    const raw = String(clientId || 'unknown').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    return raw || 'unknown';
  }

  fileEndsWithNewline(filePath, sizeBytes) {
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

  removeStaleLockAtomically(lockPath) {
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
        // Ignore cleanup failure
      }
    } catch {
      // Lock was released or claimed concurrently
    }
  }

  releaseLockIfOwned(lockPath, lockValue) {
    try {
      if (!fs.existsSync(lockPath)) return;
      const current = fs.readFileSync(lockPath, 'utf8');
      if (current === lockValue) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Ignore if already removed
    }
  }

  async removeStaleLockAtomicallyAsync(lockPath) {
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

  async releaseLockIfOwnedAsync(lockPath, lockValue) {
    try {
      const current = await fs.promises.readFile(lockPath, 'utf8');
      if (current === lockValue) {
        await fs.promises.unlink(lockPath);
      }
    } catch {
      // Ignore if already removed
    }
  }

  ensureClientDir(clientId) {
    const safeClientId = this.sanitizeClientId(clientId);
    const resolvedBase = path.resolve(this.baseDir);
    const clientDir = path.resolve(resolvedBase, safeClientId);
    if (!clientDir.startsWith(resolvedBase + path.sep)) {
      throw new Error(`Invalid storage client directory: ${clientId}`);
    }
    if (!fs.existsSync(clientDir)) {
      fs.mkdirSync(clientDir, { recursive: true });
    }
    return clientDir;
  }

  async withPartitionLock(clientId, dateStr, fn) {
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
      } catch (err) {
        if (!err || err.code !== 'EEXIST') {
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

  extractSafePartitionDate(rawTimestamp) {
    const fallback = new Date().toISOString().slice(0, 10);
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

  getTargetFilePath(clientId, dateStr, incomingBytes = 0) {
    const clientDir = this.ensureClientDir(clientId);
    const date = this.extractSafePartitionDate(dateStr);
    let baseFileName = `${date}.csv`;
    let targetPath = path.join(clientDir, baseFileName);

    let partIndex = 1;
    while (fs.existsSync(targetPath)) {
      let stats;
      try {
        stats = fs.statSync(targetPath);
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          break;
        }
        throw err;
      }
      const overflowsLimit =
        stats.size > 0 &&
        incomingBytes > 0 &&
        stats.size + incomingBytes > this.maxFileSize;
      if (stats.size >= this.maxFileSize || overflowsLimit) {
        partIndex += 1;
        baseFileName = `${date}-part${partIndex}.csv`;
        targetPath = path.join(clientDir, baseFileName);
      } else {
        break;
      }
    }

    return targetPath;
  }

  async writeBatch(events) {
    if (!events || events.length === 0) return { written: 0, files: [] };

    const grouped = new Map();
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

    const files = [];
    const fields = ['clientId', 'eventId', 'timestamp', 'payload'];

    for (const { clientId, date, events: batch } of grouped.values()) {
      const cleanBatch = batch.map((item) => ({
        clientId: item.clientId,
        eventId: item.eventId,
        timestamp: item.timestamp,
        payload: typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload),
      }));

      const bodyCsvNoHeader = new Parser({ fields, header: false, eol: '\n' }).parse(cleanBatch);
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
          fs.appendFileSync(resolvedPath, (endsWithNl ? '' : '\n') + bodyCsvNoHeader, 'utf8');
        } else {
          const fullCsv = new Parser({ fields, header: true, eol: '\n' }).parse(cleanBatch);
          fs.writeFileSync(resolvedPath, fullCsv, 'utf8');
        }

        return resolvedPath;
      });

      files.push(targetPath);
    }

    return { written: events.length, files };
  }

  pruneExpiredPartitions(autoPruneDays) {
    const days = Number(autoPruneDays);
    if (!Number.isFinite(days) || days <= 0 || !fs.existsSync(this.baseDir)) {
      return 0;
    }

    const cutoffDate = new Date(Date.now() - Math.floor(days) * 86400000)
      .toISOString()
      .split('T')[0];

    let prunedCount = 0;
    try {
      const clientDirs = fs.readdirSync(this.baseDir);
      for (const clientDir of clientDirs) {
        const fullClientPath = path.join(this.baseDir, clientDir);
        let dirLstat;
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
            let fileLstat;
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
            } catch (err) {
              if (err && err.code === 'EEXIST') {
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
                  acquired = false;
                }
              }
            }

            if (!acquired) continue;

            try {
              if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
                prunedCount += 1;
              }
            } catch {
              // Ignore individual file unlink failure
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

  async pruneExpiredPartitionsAsync(autoPruneDays) {
    const days = Number(autoPruneDays);
    if (!Number.isFinite(days) || days <= 0) {
      return 0;
    }

    const baseStat = await fs.promises.lstat(this.baseDir).catch(() => null);
    if (!baseStat || !baseStat.isDirectory()) {
      return 0;
    }

    const cutoffDate = new Date(Date.now() - Math.floor(days) * 86400000)
      .toISOString()
      .split('T')[0];

    let prunedCount = 0;
    try {
      const clientDirs = await fs.promises.readdir(this.baseDir);
      for (const clientDir of clientDirs) {
        const fullClientPath = path.join(this.baseDir, clientDir);
        const dirLstat = await fs.promises.lstat(fullClientPath).catch(() => null);
        if (!dirLstat || dirLstat.isSymbolicLink() || !dirLstat.isDirectory()) continue;

        const files = await fs.promises.readdir(fullClientPath).catch(() => []);
        for (const file of files) {
          if (!file.endsWith('.csv')) continue;
          const datePart = file.replace('.csv', '').split('-part')[0];
          if (/^\d{4}-\d{2}-\d{2}$/.test(datePart) && datePart < cutoffDate) {
            const fullPath = path.join(fullClientPath, file);
            const fileLstat = await fs.promises.lstat(fullPath).catch(() => null);
            if (!fileLstat || fileLstat.isSymbolicLink() || !fileLstat.isFile()) continue;

            const lockPath = path.join(fullClientPath, `.${datePart}.csv.lock`);
            const lockValue = `${process.pid}:${Date.now()}:${crypto.randomUUID()}`;
            let acquired = false;
            const tryAcquireLock = async () => {
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
            } catch (err) {
              if (err && err.code === 'EEXIST') {
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
              prunedCount += 1;
            } catch {
              // Ignore individual file unlink failure
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
}

module.exports = { CsvWriterWorker, resolveDefaultStorageDir };
