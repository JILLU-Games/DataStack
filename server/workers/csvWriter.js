const fs = require('fs');
const path = require('path');
const { Parser } = require('json2csv');

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

  getTargetFilePath(clientId, dateStr) {
    const safeClientId = String(clientId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const clientDir = path.join(this.baseDir, safeClientId);
    if (!fs.existsSync(clientDir)) {
      fs.mkdirSync(clientDir, { recursive: true });
    }

    const date = dateStr || new Date().toISOString().split('T')[0];
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
      const date = (evt.timestamp || new Date().toISOString()).split('T')[0];
      const key = `${evt.clientId}:::${date}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(evt);
    }

    const files = [];
    const fields = ['clientId', 'eventId', 'timestamp', 'payload'];

    for (const [key, batch] of grouped.entries()) {
      const [clientId, date] = key.split(':::');
      const targetPath = this.getTargetFilePath(clientId, date);
      const fileExists = fs.existsSync(targetPath);

      const cleanBatch = batch.map((item) => ({
        clientId: item.clientId,
        eventId: item.eventId,
        timestamp: item.timestamp,
        payload: typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload),
      }));

      const parser = new Parser({ fields, header: !fileExists, eol: '\n' });
      const csv = parser.parse(cleanBatch);

      if (fileExists) {
        fs.appendFileSync(targetPath, '\n' + csv, 'utf8');
      } else {
        fs.writeFileSync(targetPath, csv, 'utf8');
      }

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
