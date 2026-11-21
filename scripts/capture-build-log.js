#!/usr/bin/env node
/**
 * Captures Next.js production build output & metadata into `.next/standalone/build.log`
 * and `.next/standalone/build-meta.json` (plus runtime logs dir when writable) so
 * build diagnostics are inspectable via MCP `read_build_logs` inside running containers.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveRuntimeLogsDir, scrubSensitiveLogText } = require('../server/runtimeLogCapture');

const MAX_BUILD_LOG_BYTES = 512 * 1024;
const nextBin = require.resolve('next/dist/bin/next');
const pkg = require(path.resolve(__dirname, '..', 'package.json'));

const startedAt = new Date().toISOString();
const startMs = Date.now();
const capturedChunks = [];
let capturedBytes = 0;

function recordChunk(text) {
  const clean = scrubSensitiveLogText(text);
  capturedChunks.push(clean);
  capturedBytes += Buffer.byteLength(clean, 'utf8');
  while (capturedBytes > MAX_BUILD_LOG_BYTES && capturedChunks.length > 1) {
    const dropped = capturedChunks.shift();
    capturedBytes -= Buffer.byteLength(dropped, 'utf8');
  }
}

const childEnv = {
  ...process.env,
  NODE_ENV: 'production',
};

const child = spawn(process.execPath, [nextBin, 'build'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: false,
  env: childEnv,
});

child.stdout.on('data', (buf) => {
  process.stdout.write(buf);
  recordChunk(buf.toString('utf8'));
});

child.stderr.on('data', (buf) => {
  process.stderr.write(buf);
  recordChunk(buf.toString('utf8'));
});

child.on('error', (err) => {
  console.error('[DataStack Build] Failed to spawn Next.js build:', err.message);
  process.exit(1);
});

child.on('close', (code) => {
  const exitCode = typeof code === 'number' ? code : 1;
  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  const meta = {
    appName: pkg.name || 'datastack',
    appVersion: pkg.version || '0.1.0',
    nodeVersion: process.version,
    nextVersion: (pkg.dependencies && pkg.dependencies.next) || 'unknown',
    startedAt,
    finishedAt,
    durationMs,
    exitCode,
    status: exitCode === 0 ? 'succeeded' : 'failed',
  };

  const fullLog = capturedChunks.join('');
  const writeArtifactDir = (dir, logName, metaName) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, logName), fullLog, 'utf8');
      fs.writeFileSync(path.join(dir, metaName), JSON.stringify(meta, null, 2) + '\n', 'utf8');
    } catch {
      // Non-fatal if target dir is read-only or unavailable
    }
  };

  const standaloneDir = path.resolve(process.cwd(), '.next', 'standalone');
  if (exitCode === 0 && fs.existsSync(standaloneDir)) {
    writeArtifactDir(standaloneDir, 'build.log', 'build-meta.json');
  }

  const runtimeLogsDir = resolveRuntimeLogsDir(process.env);
  writeArtifactDir(runtimeLogsDir, 'last-build.log', 'last-build-meta.json');

  process.exit(exitCode);
});
