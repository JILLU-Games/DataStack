#!/usr/bin/env node
/**
 * DataStack Unified Production Runner
 * Starts both the Next.js Web Console (Port 3000 / $PORT) and
 * the Express + Socket.IO Ingestion Server (Port 4000 / $PORT_SOCKET).
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const { appendRuntimeLogLine } = require('../server/runtimeLogCapture');

const webPort = String(process.env.PORT || '3000');
const nextBin = require.resolve('next/dist/bin/next');
const serverEntry = path.resolve(__dirname, '..', 'server', 'index.js');
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 7000;

const childEnv = {
  ...process.env,
  DATASTACK_LOG_CAPTURED_BY_RUNNER: '1',
};

const webProc = spawn(
  process.execPath,
  [nextBin, 'start', '-p', webPort, '-H', '0.0.0.0'],
  {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false,
    env: childEnv,
  },
);

const serverProc = spawn(process.execPath, [serverEntry], {
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: false,
  env: childEnv,
});

function wireStreamCapture(proc, serviceName) {
  if (proc.stdout) {
    proc.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      appendRuntimeLogLine(serviceName, 'stdout', chunk.toString('utf8'));
    });
  }
  if (proc.stderr) {
    proc.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      appendRuntimeLogLine(serviceName, 'stderr', chunk.toString('utf8'));
    });
  }
}

wireStreamCapture(webProc, 'web');
wireStreamCapture(serverProc, 'ingestion');

let shuttingDown = false;
let exitedChildren = 0;
let webExited = false;
let serverExited = false;
let exitCodePending = 0;

function markChildExited() {
  exitedChildren += 1;
  if (shuttingDown && exitedChildren >= 2) {
    process.exit(exitCodePending);
  }
}

function signalChild(child, exited, signal) {
  if (exited || child.killed) return;
  try {
    child.kill(signal);
  } catch {
    // Child already exited
  }
}

function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCodePending = exitCode;
  signalChild(webProc, webExited, signal);
  signalChild(serverProc, serverExited, signal);
  if (exitedChildren >= 2) {
    process.exit(exitCodePending);
    return;
  }
  setTimeout(() => {
    signalChild(webProc, webExited, 'SIGKILL');
    signalChild(serverProc, serverExited, 'SIGKILL');
    process.exit(exitCodePending);
  }, GRACEFUL_SHUTDOWN_TIMEOUT_MS).unref();
}

process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('SIGTERM', () => shutdown('SIGTERM', 0));

webProc.on('exit', (code) => {
  webExited = true;
  markChildExited();
  if (!shuttingDown) {
    console.error(`[DataStack] Next.js production server exited with code ${code ?? 0}`);
    shutdown('SIGTERM', code || 1);
  }
});

serverProc.on('exit', (code) => {
  serverExited = true;
  markChildExited();
  if (!shuttingDown) {
    console.error(`[DataStack] Ingestion server exited with code ${code ?? 0}`);
    shutdown('SIGTERM', code || 1);
  }
});
