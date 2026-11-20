import fs from 'node:fs';
import path from 'node:path';
import type { DataStackEnvelope } from './types';

export interface DiskSpoolerOptions {
  spoolDir?: string;
  maxSizeMb?: number;
  enabled?: boolean;
}

/**
 * Durable newline-delimited JSON (`.datastack_spool/spool.jsonl`) local disk spooler
 * for offline telemetry persistence when both Port 4000 WebSocket and Port 3000 HTTP
 * endpoints are temporarily unreachable.
 */
export class DiskSpooler {
  public readonly spoolDir: string;
  public readonly spoolFile: string;
  public readonly maxBytes: number;
  public readonly enabled: boolean;

  constructor(options: DiskSpoolerOptions = {}) {
    this.spoolDir = path.resolve(options.spoolDir || '.datastack_spool');
    this.spoolFile = path.join(this.spoolDir, 'spool.jsonl');
    const maxSizeMb = Number(options.maxSizeMb ?? 50);
    this.maxBytes = Math.max(1, Number.isFinite(maxSizeMb) ? maxSizeMb : 50) * 1024 * 1024;
    this.enabled = options.enabled !== false;
  }

  private ensureDir(): void {
    if (!this.enabled) return;
    if (!fs.existsSync(this.spoolDir)) {
      fs.mkdirSync(this.spoolDir, { recursive: true });
    }
  }

  /**
   * Appends one or more event envelopes to `spool.jsonl`.
   * Returns the number of events persisted to disk.
   */
  public enqueue(items: DataStackEnvelope | DataStackEnvelope[]): number {
    if (!this.enabled) return 0;
    const list = Array.isArray(items) ? items : [items];
    if (list.length === 0) return 0;

    this.ensureDir();
    const currentSize = this.sizeBytes();
    const lines = list.map((item) => JSON.stringify(item)).join('\n') + '\n';
    const byteLength = Buffer.byteLength(lines, 'utf8');

    if (currentSize + byteLength > this.maxBytes) {
      return 0;
    }

    const fd = fs.openSync(this.spoolFile, 'a');
    try {
      fs.writeFileSync(fd, lines, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return list.length;
  }

  /**
   * Reads up to `limit` spooled event envelopes from the head of `spool.jsonl`
   * without removing them until `removeFirst(count)` is called after server ACK.
   */
  public peekBatch(limit = 250): DataStackEnvelope[] {
    if (!this.enabled || !fs.existsSync(this.spoolFile)) {
      return [];
    }
    const raw = fs.readFileSync(this.spoolFile, 'utf8');
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const results: DataStackEnvelope[] = [];
    for (const line of lines.slice(0, Math.max(1, limit))) {
      try {
        const parsed = JSON.parse(line) as DataStackEnvelope;
        if (parsed && typeof parsed === 'object' && parsed.eventId && parsed.data) {
          results.push(parsed);
        }
      } catch {
        // Skip malformed line
      }
    }
    return results;
  }

  /**
   * Atomically removes the first `removeCount` lines from `spool.jsonl`
   * via a temporary file + `fsync` + `renameSync`.
   */
  public removeFirst(removeCount: number): void {
    if (!this.enabled || removeCount <= 0 || !fs.existsSync(this.spoolFile)) {
      return;
    }
    const raw = fs.readFileSync(this.spoolFile, 'utf8');
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const remaining = lines.slice(removeCount);
    if (remaining.length === 0) {
      try {
        fs.unlinkSync(this.spoolFile);
      } catch {
        // Ignore if already removed
      }
      return;
    }

    this.ensureDir();
    const tmpFile = `${this.spoolFile}.${process.pid}.${Date.now()}.tmp`;
    const payload = remaining.join('\n') + '\n';
    try {
      const fd = fs.openSync(tmpFile, 'w');
      try {
        fs.writeFileSync(fd, payload, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpFile, this.spoolFile);
    } catch (err) {
      try {
        if (fs.existsSync(tmpFile)) {
          fs.unlinkSync(tmpFile);
        }
      } catch {
        // Ignore cleanup failure
      }
      throw err;
    }
  }

  public count(): number {
    if (!this.enabled || !fs.existsSync(this.spoolFile)) {
      return 0;
    }
    try {
      const raw = fs.readFileSync(this.spoolFile, 'utf8');
      return raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  public sizeBytes(): number {
    if (!this.enabled || !fs.existsSync(this.spoolFile)) {
      return 0;
    }
    try {
      return fs.statSync(this.spoolFile).size;
    } catch {
      return 0;
    }
  }

  public clear(): void {
    if (fs.existsSync(this.spoolFile)) {
      try {
        fs.unlinkSync(this.spoolFile);
      } catch {
        // Ignore
      }
    }
  }
}
