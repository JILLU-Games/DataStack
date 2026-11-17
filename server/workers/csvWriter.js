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

/**
 * Background CSV Writer Worker
 * Flushes batches of real-time events to partitioned CSV files.
 * Path convention: /storage/data/{clientId}/{YYYY-MM-DD}.csv
 */
class CsvWriterWorker {
  constructor(baseDir = path.resolve(__dirname, '../../storage/data'), maxFileSize = 100 * 1024 * 1024) {
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

  ensureClientDir(clientId) {
    const safeClientId = String(clientId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const clientDir = path.join(this.baseDir, safeClientId);
    if (!fs.existsSync(clientDir)) {
      fs.mkdirSync(clientDir, { recursive: true });
    }
    return clientDir;
  }

  async withPartitionLock(clientId, dateStr, fn) {
    const clientDir = this.ensureClientDir(clientId);
    const date = this.extractSafePartitionDate(dateStr);
    const lockPath = path.join(clientDir, `.${date}.csv.lock`);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    let acquired = false;
    while (Date.now() < deadline) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        try {
          fs.writeFileSync(fd, `${process.pid}:${Date.now()}`, 'utf8');
        } finally {
          fs.closeSync(fd);
        }
        acquired = true;
        break;
      } catch (err) {
        if (!err || err.code !== 'EEXIST') {
          throw err;
        }
        try {
          const lockStat = fs.statSync(lockPath);
          if (Date.now() - lockStat.mtimeMs > STALE_LOCK_AGE_MS) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Released concurrently
        }
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
      try {
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        // Ignore if already removed
      }
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

  getTargetFilePath(clientId, dateStr) {
    const clientDir = this.ensureClientDir(clientId);
    const date = this.extractSafePartitionDate(dateStr);
    let baseFileName = `${date}.csv`;
    let targetPath = path.join(clientDir, baseFileName);

    let partIndex = 1;
    while (fs.existsSync(targetPath)) {
      try {
        const stats = fs.statSync(targetPath);
        if (stats.size >= this.maxFileSize) {
          partIndex += 1;
          baseFileName = `${date}-part${partIndex}.csv`;
          targetPath = path.join(clientDir, baseFileName);
        } else {
          break;
        }
      } catch {
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
      const key = `${evt.clientId}:::${date}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(evt);
    }

    const files = [];
    const fields = ['clientId', 'eventId', 'timestamp', 'payload'];

    for (const [key, batch] of grouped.entries()) {
      const [clientId, date] = key.split(':::');
      const targetPath = await this.withPartitionLock(clientId, date, () => {
        const resolvedPath = this.getTargetFilePath(clientId, date);
        let hasContent = false;
        try {
          hasContent =
            fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).size > 0;
        } catch {
          hasContent = false;
        }

        const cleanBatch = batch.map((item) => ({
          clientId: item.clientId,
          eventId: item.eventId,
          timestamp: item.timestamp,
          payload: typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload),
        }));

        const parser = new Parser({ fields, header: !hasContent, eol: '\n' });
        const csv = parser.parse(cleanBatch);

        if (hasContent) {
          fs.appendFileSync(resolvedPath, '\n' + csv, 'utf8');
        } else {
          fs.writeFileSync(resolvedPath, csv, 'utf8');
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
        if (!fs.statSync(fullClientPath).isDirectory()) continue;

        const files = fs.readdirSync(fullClientPath);
        for (const file of files) {
          if (!file.endsWith('.csv')) continue;
          const datePart = file.replace('.csv', '').split('-part')[0];
          if (/^\d{4}-\d{2}-\d{2}$/.test(datePart) && datePart < cutoffDate) {
            try {
              fs.unlinkSync(path.join(fullClientPath, file));
              prunedCount += 1;
            } catch {
              // Ignore individual file unlink failure
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

module.exports = { CsvWriterWorker };
