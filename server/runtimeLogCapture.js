const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024; // 2 MB per service file (+ .1 backup)
const DEFAULT_TAIL_LINES = 120;
const MAX_TAIL_LINES = 500;
const MAX_SCAN_TAIL_BYTES = 512 * 1024; // Bound in-memory file slice reads

const SECRET_SCRUB_PATTERNS = [
  [/\b(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]'],
  [/\b(dsmcp_)[A-Za-z0-9_-]{8,}\b/gi, '$1[REDACTED]'],
  [/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.)[A-Za-z0-9_-]+\b/g, '$1[REDACTED]'],
  [/("(?:token|secret|password|jwtSecret|s3SecretAccessKey|webhookSecret|prometheusMetricsToken|coolifyToken|mcpToken|x-datastack-internal-secret)"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3'],
];

function scrubSensitiveLogText(rawText) {
  let clean = String(rawText ?? '');
  for (const [pattern, replacement] of SECRET_SCRUB_PATTERNS) {
    clean = clean.replace(pattern, replacement);
  }
  return clean;
}

function resolveRuntimeLogsDir(env = process.env) {
  const explicitDir = typeof env.DATASTACK_RUNTIME_LOGS_DIR === 'string'
    ? env.DATASTACK_RUNTIME_LOGS_DIR.trim()
    : '';
  if (explicitDir) {
    return path.resolve(explicitDir);
  }

  const storageDir = typeof env.DATASTACK_STORAGE_DIR === 'string'
    ? env.DATASTACK_STORAGE_DIR.trim()
    : '';
  if (storageDir) {
    const resolved = path.resolve(storageDir);
    if (path.basename(resolved).toLowerCase() === 'data') {
      return path.join(path.dirname(resolved), '.runtime-logs');
    }
    return path.join(resolved, '.runtime-logs');
  }

  return path.resolve(process.cwd(), 'storage', '.runtime-logs');
}

function normalizeServiceName(service) {
  const s = String(service || '').trim().toLowerCase();
  if (s === 'web' || s === 'nextjs') return 'web';
  if (s === 'ingestion' || s === 'server' || s === 'socket') return 'ingestion';
  return 'web';
}

function getServiceLogFilePath(service, logsDir = resolveRuntimeLogsDir()) {
  const safeService = normalizeServiceName(service);
  return path.join(logsDir, `${safeService}.log`);
}

function rotateLogFileIfNeeded(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size >= MAX_LOG_FILE_BYTES) {
      const backupPath = `${filePath}.1`;
      try {
        if (fs.existsSync(backupPath)) {
          fs.unlinkSync(backupPath);
        }
      } catch {
        // ignore backup cleanup error
      }
      fs.renameSync(filePath, backupPath);
    }
  } catch {
    // file does not exist yet
  }
}

function appendRuntimeLogLine(service, streamName, rawChunk, options = {}) {
  const logsDir = options.logsDir || resolveRuntimeLogsDir(options.env);
  const safeService = normalizeServiceName(service);
  const text = scrubSensitiveLogText(rawChunk);
  if (!text) return 0;

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return 0;

  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const filePath = getServiceLogFilePath(safeService, logsDir);
    rotateLogFileIfNeeded(filePath);
    const level = streamName === 'stderr' ? 'error' : 'info';
    const ts = new Date().toISOString();
    const formatted =
      lines
        .map((line) => JSON.stringify({ ts, service: safeService, level, message: line }))
        .join('\n') + '\n';
    fs.appendFileSync(filePath, formatted, 'utf8');
    return lines.length;
  } catch {
    return 0;
  }
}

function installRuntimeLogHook(service, options = {}) {
  const safeService = normalizeServiceName(service);
  if (process.env.DATASTACK_LOG_CAPTURED_BY_RUNNER === '1' && !options.force) {
    return { installed: false, reason: 'captured_by_runner' };
  }
  const guardKey = `__dataStackRuntimeLogHook_${safeService}`;
  if (globalThis[guardKey]) {
    return { installed: false, reason: 'already_installed' };
  }
  globalThis[guardKey] = true;

  let isWriting = false;
  const wrapStream = (stream, streamName) => {
    const originalWrite = stream.write.bind(stream);
    stream.write = function patchedWrite(chunk, encoding, callback) {
      const result = originalWrite(chunk, encoding, callback);
      if (!isWriting) {
        isWriting = true;
        try {
          const raw =
            typeof chunk === 'string'
              ? chunk
              : Buffer.isBuffer(chunk)
                ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8')
                : String(chunk ?? '');
          appendRuntimeLogLine(safeService, streamName, raw, options);
        } catch {
          // Never interrupt stdout/stderr
        } finally {
          isWriting = false;
        }
      }
      return result;
    };
  };

  wrapStream(process.stdout, 'stdout');
  wrapStream(process.stderr, 'stderr');
  return { installed: true, service: safeService };
}

function readTailLinesFromFile(filePath, maxBytes = MAX_SCAN_TAIL_BYTES) {
  if (!fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) return [];

  const readSize = Math.min(stat.size, maxBytes);
  const startPos = Math.max(0, stat.size - readSize);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(readSize);
    const bytesRead = fs.readSync(fd, buf, 0, readSize, startPos);
    let content = buf.subarray(0, bytesRead).toString('utf8');
    if (startPos > 0) {
      const firstNewline = content.indexOf('\n');
      content = firstNewline >= 0 ? content.slice(firstNewline + 1) : '';
    }
    return content.split(/\r?\n/).filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function parseStoredLogLine(rawLine, fallbackService) {
  try {
    const parsed = JSON.parse(rawLine);
    if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') {
      return {
        ts: typeof parsed.ts === 'string' ? parsed.ts : '',
        service: typeof parsed.service === 'string' ? parsed.service : fallbackService,
        level: typeof parsed.level === 'string' ? parsed.level : 'info',
        message: parsed.message,
      };
    }
  } catch {
    // Plain-text fallback
  }
  return {
    ts: '',
    service: fallbackService,
    level: 'info',
    message: rawLine,
  };
}

function readRuntimeLogs(options = {}) {
  const logsDir = options.logsDir || resolveRuntimeLogsDir(options.env);
  const serviceFilter = String(options.service || 'all').trim().toLowerCase();
  const requestedLines = Number(options.lines);
  const limit = Number.isFinite(requestedLines)
    ? Math.min(MAX_TAIL_LINES, Math.max(1, Math.floor(requestedLines)))
    : DEFAULT_TAIL_LINES;
  const search = typeof options.search === 'string' ? options.search.trim().toLowerCase() : '';
  const levelFilter = typeof options.level === 'string' ? options.level.trim().toLowerCase() : '';

  const services =
    serviceFilter === 'web'
      ? ['web']
      : serviceFilter === 'ingestion'
        ? ['ingestion']
        : ['web', 'ingestion'];

  const collected = [];
  const filesChecked = [];
  for (const svc of services) {
    const mainFile = getServiceLogFilePath(svc, logsDir);
    const backupFile = `${mainFile}.1`;
    for (const candidate of [backupFile, mainFile]) {
      if (fs.existsSync(candidate)) {
        filesChecked.push(path.basename(candidate));
        const rawLines = readTailLinesFromFile(candidate);
        for (const rawLine of rawLines) {
          const entry = parseStoredLogLine(rawLine, svc);
          if (levelFilter && levelFilter !== 'all' && entry.level !== levelFilter) {
            continue;
          }
          if (
            search &&
            !entry.message.toLowerCase().includes(search) &&
            !entry.service.toLowerCase().includes(search)
          ) {
            continue;
          }
          collected.push(entry);
        }
      }
    }
  }

  if (filesChecked.length === 0) {
    return {
      entries: [],
      totalMatched: 0,
      filesChecked: [],
      logsDir,
      exists: false,
      code: 'LOG_CAPTURE_UNAVAILABLE',
      warning: 'No runtime logs captured yet in .runtime-logs/. Start services or emit stdout logs first.',
    };
  }

  collected.sort((a, b) => {
    if (a.ts && b.ts && a.ts !== b.ts) {
      return a.ts.localeCompare(b.ts);
    }
    return 0;
  });

  const entries = collected.slice(-limit);
  return {
    entries,
    totalMatched: collected.length,
    filesChecked,
    logsDir,
    exists: true,
  };
}

function readBuildLogs(options = {}) {
  const logsDir = options.logsDir || resolveRuntimeLogsDir(options.env);
  const cwd = options.cwd || process.cwd();
  const requestedLines = Number(options.lines);
  const limit = Number.isFinite(requestedLines)
    ? Math.min(MAX_TAIL_LINES, Math.max(1, Math.floor(requestedLines)))
    : 200;
  const search = typeof options.search === 'string' ? options.search.trim().toLowerCase() : '';

  const metaCandidates = [
    path.join(logsDir, 'last-build-meta.json'),
    path.join(cwd, 'build-meta.json'),
    path.join(cwd, '.next', 'standalone', 'build-meta.json'),
  ];
  const logCandidates = [
    path.join(logsDir, 'last-build.log'),
    path.join(cwd, 'build.log'),
    path.join(cwd, '.next', 'standalone', 'build.log'),
  ];

  let meta = null;
  for (const metaPath of metaCandidates) {
    try {
      if (fs.existsSync(metaPath)) {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        break;
      }
    } catch {
      // try next candidate
    }
  }

  let logPathUsed = null;
  let allLines = [];
  for (const logPath of logCandidates) {
    try {
      if (fs.existsSync(logPath)) {
        logPathUsed = path.basename(logPath);
        allLines = readTailLinesFromFile(logPath);
        break;
      }
    } catch {
      // try next candidate
    }
  }

  if (!meta && !logPathUsed) {
    return {
      meta: null,
      lines: [],
      totalLines: 0,
      exists: false,
      code: 'LOG_CAPTURE_UNAVAILABLE',
      warning: 'No captured build log or build-meta.json found yet. Run npm run build first.',
    };
  }

  const filtered = search
    ? allLines.filter((line) => line.toLowerCase().includes(search))
    : allLines;

  return {
    meta,
    logFile: logPathUsed,
    lines: filtered.slice(-limit),
    totalLines: filtered.length,
    exists: true,
  };
}

function syncStandaloneBuildArtifactsToLogsDir(options = {}) {
  const logsDir = options.logsDir || resolveRuntimeLogsDir(options.env);
  const cwd = options.cwd || process.cwd();
  const buildLogSrc = [
    path.join(cwd, 'build.log'),
    path.join(cwd, '.next', 'standalone', 'build.log'),
  ].find((candidate) => fs.existsSync(candidate));
  const buildMetaSrc = [
    path.join(cwd, 'build-meta.json'),
    path.join(cwd, '.next', 'standalone', 'build-meta.json'),
  ].find((candidate) => fs.existsSync(candidate));

  if (!buildLogSrc && !buildMetaSrc) {
    return { synced: false };
  }

  try {
    fs.mkdirSync(logsDir, { recursive: true });
    if (buildLogSrc) {
      fs.copyFileSync(buildLogSrc, path.join(logsDir, 'last-build.log'));
    }
    if (buildMetaSrc) {
      fs.copyFileSync(buildMetaSrc, path.join(logsDir, 'last-build-meta.json'));
    }
    return { synced: true, logsDir };
  } catch {
    return { synced: false };
  }
}

module.exports = {
  MAX_LOG_FILE_BYTES,
  scrubSensitiveLogText,
  resolveRuntimeLogsDir,
  getServiceLogFilePath,
  appendRuntimeLogLine,
  installRuntimeLogHook,
  readRuntimeLogs,
  readBuildLogs,
  syncStandaloneBuildArtifactsToLogsDir,
};
